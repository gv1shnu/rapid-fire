import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { parseResult } from '../src/student-api';
let db: PGlite;
const host = '00000000-0000-0000-0000-000000000001';
const player = '00000000-0000-0000-0000-000000000002';
let session: string;
let migration: string;
async function identity(id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role supabase_auth_admin;create schema auth;create schema realtime;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$select$$;`);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  // Everything from 008 onward is the upgrade under test: bundle it in order so
  // later migrations that build on 008's objects apply after it, not before.
  migration = '';
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    if (file.slice(0, 12) >= '202609110008') migration += sql + '\n';
    else await db.exec(sql);
  }
  await db.exec(
    readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8'),
  );
  await db.exec(`insert into public.allowed_domains values('example.edu'),('partner.example');
 insert into auth.users values('${host}','host@example.edu',now(),'{"provider":"google"}'),('${player}','student@example.edu',now(),'{"provider":"google"}');
 insert into public.instructor_emails values('host@example.edu');`);
  await identity(host);
  session = (
    await db.query<{ v: { session_id: string } }>(
      "select public.open_session('A',clock_timestamp()+interval '1 hour') v",
    )
  ).rows[0].v.session_id;
  await db.query(
    'select public.configure_round($1,1::smallint,1::smallint,12::smallint)',
    [session],
  );
  await db.query('select public.go_live($1,1::smallint)', [session]);
  await identity(player);
  await db.query(
    "select public.join_session((select code from public.sessions where id=$1),'Student','seed')",
    [session],
  );
  await db.query('select public.start_round($1,1::smallint)', [session]);
}, 30000);
afterEach(async () => {
  await db?.close();
});
describe('upgrade from migration 007', () => {
  it('refuses to change the wire protocol during a live assessment', async () => {
    await expect(db.exec(migration)).rejects.toThrow(
      'end_live_releases_before_protocol_upgrade',
    );
  });
  it('preserves historical scores, timing classification, membership and full result recovery', async () => {
    await db.exec(
      "update public.attempts a set served_at=clock_timestamp()-interval '12.5 seconds',answered_at=clock_timestamp(),option_id=(select id from public.options o where o.question_id=a.question_id and is_correct)",
    );
    const original = (
      await db.query<{ v: { total_points: number } }>(
        'select public.submit_round($1,1::smallint) v',
        [session],
      )
    ).rows[0].v;
    expect(original.total_points).toBe(100);
    await identity(host);
    await db.query('select public.end_round($1,1::smallint)', [session]);
    await db.exec(migration);
    // Solutions unlock only once the whole rapid fire is over.
    await db.query('select public.end_session($1)', [session]);
    await identity(player);
    const upgraded = (
      await db.query<{ v: unknown }>(
        'select public.my_result($1,1::smallint) v',
        [session],
      )
    ).rows[0].v;
    const parsed = parseResult(upgraded);
    expect(parsed.total_points).toBe(100);
    expect(parsed.questions[0].stem.length).toBeGreaterThan(0);
    expect(parsed.questions[0].options).toHaveLength(4);
    await identity(host);
    const report = (
      await db.query<{
        v: { questions: { correct_count: number; timeout_count: number }[] };
      }>('select public.round_report($1,1::smallint) v', [session])
    ).rows[0].v;
    expect(report.questions[0].correct_count).toBe(1);
    expect(report.questions[0].timeout_count).toBe(0);
    expect(
      (
        await db.query(
          "select domain from public.allowed_domains where domain='partner.example'",
        )
      ).rows,
    ).toEqual([]);
  });
});
