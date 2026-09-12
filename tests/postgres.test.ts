import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Run only against a disposable database, never the linked Supabase project.
const url = process.env.POSTGRES_TEST_URL;
const host = '00000000-0000-0000-0000-000000000001';
const students = Array.from(
  { length: 120 },
  (_, i) => `10000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
);
let pool: Pool;
let session: string;
async function asUser<T>(
  uid: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("set local statement_timeout='15s'");
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid]);
    await c.query('set local role authenticated');
    const value = await work(c);
    await c.query('commit');
    return value;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
async function call<T = Record<string, unknown>>(
  uid: string,
  name: string,
  args: unknown[],
  casts: string[],
): Promise<T> {
  return asUser(
    uid,
    async (c) =>
      (
        await c.query(
          `select public.${name}(${args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',')}) value`,
          args,
        )
      ).rows[0].value,
  );
}
describe.skipIf(!url)('PostgreSQL 17 concurrent transactions', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!parsed.pathname.endsWith('_test'))
      throw new Error(
        'POSTGRES_TEST_URL must name a disposable *_test database.',
      );
    pool = new Pool({ connectionString: url, max: 24 });
    await pool.query(`drop schema if exists public cascade;drop schema if exists auth cascade;drop schema if exists realtime cascade;create schema public;
  do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin;end if;end$$;
  grant usage on schema public to anon,authenticated;
  create schema auth;create schema realtime;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
  create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$select$$;`);
    const dir = new URL('../supabase/migrations/', import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await pool.query(readFileSync(new URL(file, dir), 'utf8'));
    await pool.query(
      readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8'),
    );
    for (const [i, id] of [host, ...students].entries())
      await pool.query(
        `insert into auth.users values($1,$2,now(),'{"provider":"google"}')`,
        [id, `student${i}@example.edu`],
      );
    await pool.query(
      "insert into public.instructor_emails values('student0@example.edu')",
    );
    const opened = await call(
      host,
      'open_session',
      ['A', new Date(Date.now() + 600000).toISOString()],
      ['text', 'timestamptz'],
    );
    session = String(opened.session_id);
    await call(
      host,
      'configure_round',
      [session, 1, 2, 120],
      ['uuid', 'smallint', 'smallint', 'smallint'],
    );
    await call(host, 'go_live', [session, 1], ['uuid', 'smallint']);
    await Promise.all(
      students.map((id) =>
        call(
          id,
          'join_session',
          [opened.code, 'Student', 'seed'],
          ['text', 'text', 'text'],
        ),
      ),
    );
  }, 30000);
  afterAll(async () => {
    await pool?.end();
  });
  it('serves 120 concurrent students the same frozen set with isolated option tokens', async () => {
    const results = await Promise.all(
      students.map((id) =>
        call(id, 'start_round', [session, 1], ['uuid', 'smallint']),
      ),
    );
    expect(results.every((r) => r.seq === 1)).toBe(true);
    const rows = await pool.query(
      'select player_id,array_agg(question_id order by question_id) questions from public.attempts group by player_id',
    );
    expect(rows.rows).toHaveLength(120);
    expect(
      rows.rows.every(
        (r) =>
          JSON.stringify(r.questions) ===
          JSON.stringify(rows.rows[0].questions),
      ),
    ).toBe(true);
    const tokens = results.flatMap((r) =>
      (r.options as { id: string }[]).map((o) => o.id),
    );
    expect(new Set(tokens).size).toBe(480);
  }, 30000);
  it('serializes duplicate submissions without changing the accepted answer or next clock', async () => {
    const first = await call(
      students[0],
      'start_round',
      [session, 1],
      ['uuid', 'smallint'],
    );
    const choices = first.options as { id: string }[];
    const replies = await Promise.all(
      choices.map((o) =>
        call(
          students[0],
          'submit_answer',
          [session, 1, 1, o.id],
          ['uuid', 'smallint', 'smallint', 'uuid'],
        ),
      ),
    );
    expect(replies.every((r) => r.seq === 2)).toBe(true);
    expect(new Set(replies.map((r) => r.served_at)).size).toBe(1);
    const rows = await pool.query(
      'select count(*)::int n from public.attempts where player_id=$1 and answered_at is not null',
      [students[0]],
    );
    expect(rows.rows[0].n).toBe(1);
  });
  it('ends safely while students submit, with one immutable score record each', async () => {
    const questions = await Promise.all(
      students
        .slice(1)
        .map((id) =>
          call(id, 'start_round', [session, 1], ['uuid', 'smallint']),
        ),
    );
    const actions = students
      .slice(1)
      .map((id, i) =>
        call(
          id,
          'submit_answer',
          [session, 1, 1, (questions[i].options as { id: string }[])[0].id],
          ['uuid', 'smallint', 'smallint', 'uuid'],
        ),
      );
    const outcomes = await Promise.allSettled([
      ...actions,
      call(host, 'end_round', [session, 1], ['uuid', 'smallint']),
    ]);
    expect(outcomes.at(-1)?.status).toBe('fulfilled');
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(String(outcome.reason)).toMatch(/round_ended/);
    const rows = await pool.query(
      'select count(*)::int n,count(*) filter(where submitted_at is not null)::int done,min(total_points)::int minimum from public.round_runs',
    );
    expect(rows.rows[0].n).toBe(120);
    expect(rows.rows[0].done).toBe(120);
    expect(rows.rows[0].minimum).toBeGreaterThanOrEqual(0);
    const before = (
      await pool.query(
        'select sum(total_points)::int total from public.round_runs',
      )
    ).rows;
    await call(host, 'end_round', [session, 1], ['uuid', 'smallint']);
    expect(
      (
        await pool.query(
          'select sum(total_points)::int total from public.round_runs',
        )
      ).rows,
    ).toEqual(before);
  }, 30000);
});
