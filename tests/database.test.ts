import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
const host = '00000000-0000-0000-0000-000000000001';
const player = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';
let db: PGlite;
let session: string;
async function identity(id: string, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`set role ${role}`);
}
async function admin(sql: string, params: unknown[] = []) {
  await db.exec('reset role');
  return db.query<Record<string, unknown>>(sql, params);
}
type RpcResult = {
  session_id: string;
  code: string;
  seq: number;
  served_at: string;
  options: { id: number }[];
  questions: { points: number }[];
  total_points: number;
  cumulative_points: number;
  best_streak: number;
  leaderboard_position: number;
  error: { http_code: number };
};
async function rpc<T = RpcResult>(
  name: string,
  args: unknown[] = [],
  casts: string[] = [],
): Promise<T> {
  const result = await db.query<{ value: T }>(
    `select public.${name}(${args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ''}`).join(',')}) as value`,
    args,
  );
  return result.rows[0].value;
}
const round = (name: string) => rpc(name, [session, 1], ['uuid', 'smallint']);
function noKey(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(noKey);
    return;
  }
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      expect(k).not.toMatch(
        /is_correct|explanation|misconception|correct_option|points|score|streak/,
      );
      noKey(v);
    }
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role supabase_auth_admin;
 create schema auth; create schema realtime;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
 create table realtime.test_events(payload jsonb,event text,topic text,private boolean);
 create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$ insert into realtime.test_events values(payload,event,topic,private) $$;`);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  await db.exec(
    readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8'),
  );
  await db.exec(`insert into public.allowed_domains values('college.example');
 insert into auth.users values ('${host}','host@college.example',now(),'{"provider":"google"}'),('${player}','student@college.example',now(),'{"provider":"google"}'),('${outsider}','outsider@college.example',now(),'{"provider":"google"}');
 insert into public.instructors values('${host}');
 insert into public.roster values('host@college.example','A'),('student@college.example','A'),('outsider@college.example','B');`);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await admin(
    'truncate public.attempts,public.round_runs,public.sessions,public.players,realtime.test_events',
  );
  await identity(host);
  const opened = await rpc(
    'open_session',
    ['A', new Date(Date.now() + 75 * 60000).toISOString()],
    ['text', 'timestamptz'],
  );
  session = opened.session_id;
  await identity(player);
  await rpc('join_session', [opened.code, 'Explorer', 'seed']);
  await identity(host);
  await rpc('go_live', [session, 1], ['uuid', 'smallint']);
  await identity(player);
});
describe('sealed PostgreSQL game', () => {
  it('seeds two complete pools and nine round themes', async () => {
    const r = await admin(
      'select round_id,difficulty,count(*)::int n from public.questions group by round_id,difficulty order by round_id,difficulty',
    );
    expect(r.rows.map((x) => x.n)).toEqual([15, 10, 20, 15, 10, 20]);
  });
  it('draws 30 unique questions with the specified three legs', async () => {
    const first = await round('start_round');
    noKey(first);
    expect(first.seq).toBe(1);
    const { rows } = await admin(
      'select a.seq,q.difficulty,a.served_at from public.attempts a join public.questions q on q.id=a.question_id order by a.seq',
    );
    expect(rows).toHaveLength(30);
    expect(rows.slice(0, 10).every((r) => r.difficulty === 'easy')).toBe(true);
    expect(rows.slice(10, 20).every((r) => r.difficulty === 'medium')).toBe(
      true,
    );
    expect(rows.slice(20).filter((r) => r.difficulty === 'hard')).toHaveLength(
      6,
    );
    expect(rows.filter((r) => r.served_at)).toHaveLength(1);
  });
  it('keeps retries immutable and all served payloads free of keys', async () => {
    const first = await round('start_round');
    expect((await round('start_round')).served_at).toEqual(first.served_at);
    expect((await round('next_question')).served_at).toEqual(first.served_at);
    const next = await rpc(
      'submit_answer',
      [session, 1, 1, first.options[0].id],
      ['uuid', 'smallint', 'smallint', 'bigint'],
    );
    noKey(next);
    expect(next.seq).toBe(2);
    const retry = await rpc(
      'submit_answer',
      [session, 1, 1, first.options[1].id],
      ['uuid', 'smallint', 'smallint', 'bigint'],
    );
    expect(retry.served_at).toBe(next.served_at);
    const { rows } = await admin(
      'select option_id,points from public.attempts where seq=1',
    );
    expect(rows[0]).toEqual({ option_id: first.options[0].id, points: 0 });
  });
  it('never serializes extra answer-key metadata from question or option bodies', async () => {
    await admin(
      `update public.questions set body='{"is_correct":true,"explanation":"SECRET","misconception":"SECRET"}'::jsonb`,
    );
    await admin(
      `update public.options set body=body||'{"is_correct":true,"explanation":"SECRET","misconception":"SECRET"}'::jsonb`,
    );
    await identity(player);
    const served = await round('start_round');
    noKey(served);
    expect(JSON.stringify(served)).not.toContain('SECRET');
    await admin('update public.questions set body=null');
    await admin(
      "update public.options set body=body-'is_correct'-'explanation'-'misconception'",
    );
  });
  it('rejects early debrief, unserved answers, invalid options and early timeout', async () => {
    await round('start_round');
    await expect(round('submit_round')).rejects.toThrow('round_incomplete');
    await expect(
      rpc(
        'submit_answer',
        [session, 1, 2, 1],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('question_not_served');
    await expect(
      rpc(
        'submit_answer',
        [session, 1, 1, -1],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('invalid_option');
    await expect(
      rpc(
        'submit_answer',
        [session, 1, 1, null],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('answer_required');
  });
  it('enforces the server deadline regardless of the chosen answer', async () => {
    const first = await round('start_round');
    await admin(
      "update public.attempts set served_at=clock_timestamp()-interval '14 seconds' where seq=1",
    );
    await identity(player);
    noKey(
      await rpc(
        'submit_answer',
        [session, 1, 1, first.options[0].id],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    );
    const { rows } = await admin(
      'select option_id,answered_at from public.attempts where seq=1',
    );
    expect(rows[0].option_id).toBeNull();
    expect(rows[0].answered_at).toBeTruthy();
  });
  it.each(['closed', 'lobby', 'expired'])(
    'rejects every game endpoint when %s',
    async (status) => {
      await round('start_round');
      await admin(
        status === 'expired'
          ? "update public.sessions set closes_at=now()-interval '1 second'"
          : 'update public.sessions set status=$1',
        status === 'expired' ? [] : [status],
      );
      await identity(player);
      for (const name of ['start_round', 'next_question', 'submit_round'])
        await expect(round(name)).rejects.toThrow('session_closed');
      await expect(
        rpc(
          'submit_answer',
          [session, 1, 1, 1],
          ['uuid', 'smallint', 'smallint', 'bigint'],
        ),
      ).rejects.toThrow('session_closed');
    },
  );
  it('rejects wrong sections and checks the domain on each RPC', async () => {
    await identity(outsider);
    await expect(round('start_round')).rejects.toThrow('not_in_this_section');
    await admin('delete from public.allowed_domains');
    await identity(player);
    for (const name of ['start_round', 'next_question', 'submit_round'])
      await expect(round(name)).rejects.toThrow('domain_not_allowed');
    await expect(
      rpc(
        'submit_answer',
        [session, 1, 1, 1],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('domain_not_allowed');
    await admin("insert into public.allowed_domains values('college.example')");
  });
  it('denies table access, private helpers, hook execution and anonymous RPCs', async () => {
    for (const table of [
      'questions',
      'options',
      'attempts',
      'sessions',
      'players',
      'round_runs',
      'roster',
      'instructors',
      'allowed_domains',
    ])
      await expect(db.query(`select * from public.${table}`)).rejects.toThrow(
        'permission denied',
      );
    await expect(round('serve_pending')).rejects.toThrow('permission denied');
    await expect(rpc('assert_live', [session], ['uuid'])).rejects.toThrow(
      'permission denied',
    );
    await expect(rpc('before_user_created', [{}], ['jsonb'])).rejects.toThrow(
      'permission denied',
    );
    await identity(player, 'anon');
    await expect(round('start_round')).rejects.toThrow('permission denied');
  });
  it('restricts the signup hook to exact domains and Google', async () => {
    await identity(host, 'supabase_auth_admin');
    expect(
      await rpc(
        'before_user_created',
        [
          {
            user: {
              email: 'a@college.example',
              app_metadata: { provider: 'google' },
            },
          },
        ],
        ['jsonb'],
      ),
    ).toEqual({});
    for (const [email, provider] of [
      ['a@college.example.evil', 'google'],
      ['a@college.example', 'email'],
      ['a@gmail.com', 'google'],
    ])
      expect(
        (
          await rpc(
            'before_user_created',
            [{ user: { email, app_metadata: { provider } } }],
            ['jsonb'],
          )
        ).error.http_code,
      ).toBe(403);
  });
  it('only the assigned instructor can advance or end, in order', async () => {
    await expect(
      rpc('go_live', [session, 2], ['uuid', 'smallint']),
    ).rejects.toThrow('host_only');
    await expect(rpc('end_session', [session], ['uuid'])).rejects.toThrow(
      'host_only',
    );
    await expect(
      rpc(
        'open_session',
        ['A', new Date(Date.now() + 10000).toISOString()],
        ['text', 'timestamptz'],
      ),
    ).rejects.toThrow('host_only');
    await identity(host);
    await expect(
      rpc('go_live', [session, 3], ['uuid', 'smallint']),
    ).rejects.toThrow('round_out_of_order');
    await rpc('end_session', [session], ['uuid']);
    await identity(player);
    await expect(round('start_round')).rejects.toThrow('session_closed');
  });
  it('scores a full round only at debrief; applies streaks and caches retries', async () => {
    let next = await round('start_round');
    for (let seq = 1; seq <= 30; seq++) {
      noKey(next);
      const { rows } = await admin(
        'select o.id from public.options o join public.attempts a on a.question_id=o.question_id where a.seq=$1 and o.is_correct',
        [seq],
      );
      await identity(player);
      next = await rpc(
        'submit_answer',
        [session, 1, seq, rows[0].id],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      );
    }
    expect(next).toEqual({ round_complete: true });
    const before = await admin(
      'select sum(points)::int n from public.attempts',
    );
    expect(before.rows[0].n).toBe(0);
    await identity(player);
    const debrief = await round('submit_round');
    expect(debrief.best_streak).toBe(30);
    expect(debrief.questions).toHaveLength(30);
    expect(debrief.total_points).toBeGreaterThan(6400);
    expect(debrief.total_points).toBeLessThanOrEqual(6465);
    expect(debrief.questions[0].points).toBeLessThanOrEqual(150);
    expect(debrief.questions[2].points).toBeLessThanOrEqual(180);
    expect(debrief.questions[5].points).toBeLessThanOrEqual(225);
    expect(debrief.leaderboard_position).toBe(1);
    expect(await round('submit_round')).toEqual(debrief);
    await expect(round('start_round')).rejects.toThrow(
      'round_already_submitted',
    );
    await identity(host);
    await rpc('go_live', [session, 2], ['uuid', 'smallint']);
    await identity(player);
    const second = await rpc('start_round', [session, 2], ['uuid', 'smallint']);
    expect(second.seq).toBe(1);
    noKey(second);
    await expect(round('next_question')).rejects.toThrow('round_not_current');
    await admin(`update public.attempts a set
      served_at=clock_timestamp()-interval '6 seconds', answered_at=clock_timestamp(),
      option_id=(select o.id from public.options o where o.question_id=a.question_id and o.is_correct)
      where round_id=2`);
    await identity(player);
    const secondDebrief = await rpc(
      'submit_round',
      [session, 2],
      ['uuid', 'smallint'],
    );
    expect(secondDebrief.cumulative_points).toBe(
      debrief.total_points + secondDebrief.total_points,
    );
  });
  it('calculates exact speed, grace, wrong answers and streak reset in SQL', async () => {
    await round('start_round');
    await db.exec('reset role');
    await db.exec(`update public.attempts a set served_at='2026-01-01T00:00:00Z',answered_at='2026-01-01T00:00:06Z',option_id=(select id from public.options o where o.question_id=a.question_id and is_correct);
  update public.attempts set option_id=null where seq=7;
  update public.attempts set answered_at=served_at+interval '12.5 seconds' where seq=9;
  update public.attempts set answered_at=served_at+interval '14 seconds' where seq=10;`);
    await identity(player);
    const d = await round('submit_round');
    expect(
      d.questions.slice(0, 10).map((q: { points: number }) => q.points),
    ).toEqual([125, 125, 150, 150, 150, 188, 0, 125, 100, 0]);
  });
  it('logs scores and round metrics once, including the strict six-second boundary', async () => {
    await round('start_round');
    await admin(`update public.attempts a set
      served_at='2026-01-01T00:00:00Z', answered_at='2026-01-01T00:00:06Z',
      option_id=(select o.id from public.options o where o.question_id=a.question_id and o.is_correct)`);
    await db.exec(`
      update public.attempts set answered_at=served_at+interval '5.999 seconds' where seq=1;
      update public.attempts set answered_at=served_at+interval '12.5 seconds' where seq=3;
      update public.attempts set answered_at=served_at+interval '14 seconds',option_id=null where seq=4;
      update public.attempts a set answered_at=served_at+interval '4 seconds',
        option_id=(select o.id from public.options o where o.question_id=a.question_id and not o.is_correct limit 1) where seq=5;
    `);
    await identity(player);
    const debrief = await round('submit_round');
    expect(debrief.questions[3].points).toBe(0);
    expect(debrief.questions[4].points).toBe(0);
    expect(await round('submit_round')).toEqual(debrief);
    const metrics = await admin(
      'select correct_count,wrong_count,timeout_count,under_half_count from public.round_runs',
    );
    expect(metrics.rows).toEqual([
      {
        correct_count: 28,
        wrong_count: 1,
        timeout_count: 1,
        under_half_count: 2,
      },
    ]);

    // A second student's draw: every answer is wrong and takes two seconds.
    const code = (await admin('select code from public.sessions')).rows[0].code;
    await identity(host);
    await rpc('join_session', [code, 'Instructor test player', 'seed']);
    await round('start_round');
    await admin(
      `update public.attempts a set served_at='2026-01-01T00:00:00Z',
      answered_at='2026-01-01T00:00:02Z',
      option_id=(select o.id from public.options o where o.question_id=a.question_id and not o.is_correct limit 1)
      where player_id=$1`,
      [host],
    );
    await identity(host);
    expect((await round('submit_round')).total_points).toBe(0);
    await rpc('end_session', [session], ['uuid']);
    type Report = {
      summary: Record<string, number>;
      students: {
        player_id: string;
        score: number;
        average_answer_seconds: number;
        accuracy_percent: number;
      }[];
      questions: {
        students_under_half_time: number;
        submitted_students: number;
        accuracy_percent: number;
      }[];
    };
    const report = await rpc<Report>(
      'round_report',
      [session, 1],
      ['uuid', 'smallint'],
    );
    expect(report.summary.submitted_students).toBe(2);
    expect(report.summary.incomplete_students).toBe(0);
    expect(report.summary.students_with_under_half_answers).toBe(2);
    expect(report.summary.answers_under_half_time).toBe(32);
    expect(report.summary.average_accuracy_percent).toBeCloseTo(
      (28 / 60) * 100,
    );
    expect(report.summary.average_round_answer_seconds).toBeCloseTo(
      (192.499 + 60) / 2,
    );
    expect(report.summary.average_answer_seconds).toBeCloseTo(
      (192.499 + 60) / 60,
    );
    const logged = report.students.find((r) => r.player_id === player)!;
    expect(logged.score).toBe(debrief.total_points);
    expect(logged.accuracy_percent).toBeCloseTo((28 / 30) * 100);
    expect(logged.average_answer_seconds).toBeCloseTo(192.499 / 30);
    expect(
      report.questions.reduce((sum, q) => sum + q.students_under_half_time, 0),
    ).toBe(32);
    expect(
      report.questions.reduce((sum, q) => sum + q.submitted_students, 0),
    ).toBe(60);
    expect(
      report.questions.every(
        (q) => q.accuracy_percent >= 0 && q.accuracy_percent <= 100,
      ),
    ).toBe(true);
  });
  it('restricts reports to the assigned instructor after the sitting', async () => {
    await expect(round('round_report')).rejects.toThrow('host_only');
    await identity(host);
    await expect(round('round_report')).rejects.toThrow(
      'report_available_after_session',
    );
    await rpc('end_session', [session], ['uuid']);
    await identity(outsider);
    await expect(round('round_report')).rejects.toThrow('host_only');
    await identity(host, 'anon');
    await expect(round('round_report')).rejects.toThrow('permission denied');
    await identity(host);
    await expect(
      rpc('round_report', [session, 10], ['uuid', 'smallint']),
    ).rejects.toThrow('invalid_round');
    await admin('delete from public.allowed_domains');
    await identity(host);
    await expect(round('round_report')).rejects.toThrow('domain_not_allowed');
    await admin("insert into public.allowed_domains values('college.example')");
  });
  it('excludes unfinished runs and returns null averages rather than invented zeros', async () => {
    await round('start_round');
    await admin(
      "update public.sessions set closes_at=clock_timestamp()-interval '1 second'",
    );
    await identity(host);
    const report = await rpc<{
      summary: Record<string, number | null>;
      students: unknown[];
      questions: unknown[];
    }>('round_report', [session, 1], ['uuid', 'smallint']);
    expect(report.summary.submitted_students).toBe(0);
    expect(report.summary.incomplete_students).toBe(1);
    expect(report.summary.average_accuracy_percent).toBeNull();
    expect(report.summary.average_answer_seconds).toBeNull();
    expect(report.summary.students_with_under_half_answers).toBe(0);
    expect(report.students).toEqual([]);
    expect(report.questions).toEqual([]);
  });
  it('rejects negative points at the database layer', async () => {
    await round('start_round');
    await expect(
      admin('update public.attempts set points=-1 where seq=1'),
    ).rejects.toThrow('nonnegative_points');
    await expect(
      admin('update public.round_runs set total_points=-1'),
    ).rejects.toThrow('nonnegative_total_points');
  });
  it('enforces four options with exactly one correct at commit', async () => {
    await admin('begin');
    await db.exec(
      "insert into public.questions(round_id,display_type,difficulty,stem,explanation) values(1,'concept','easy','Invalid?','Invalid fixture')",
    );
    await expect(db.exec('commit')).rejects.toThrow(
      'question_requires_four_options_one_correct',
    );
    await db.exec('rollback');
  });
});
