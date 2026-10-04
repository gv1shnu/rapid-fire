import { parseSessionReport, parseRoundReport } from '../src/instructor-api';
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
  options: { id: string }[];
  tempt_options: string[];
  round_id: number;
  deadline: string;
  server_now: string;
  round_complete: boolean;
  submitted: boolean;
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
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
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
  await db.exec(`
 insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values ('${host}','host@example.edu',now(),'{"provider":"google"}','{"full_name":"Host Instructor"}'),('${player}','student@example.edu',now(),'{"provider":"google"}','{"full_name":"Vishnu Gandarapu"}'),('${outsider}','outsider@example.edu',now(),'{"provider":"google"}','{"full_name":"Outsider Student"}');
 insert into public.instructor_emails values('host@example.edu');
 insert into public.roster values('host@example.edu','A'),('student@example.edu','A'),('outsider@example.edu','B');`);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await admin(
    'truncate public.join_limits,public.session_members,public.release_questions,public.round_releases,public.attempts,public.round_runs,public.sessions,public.players,realtime.test_events',
  );
  await identity(host);
  const opened = await rpc(
    'open_session',
    ['A', new Date(Date.now() + 75 * 60000).toISOString()],
    ['text', 'timestamptz'],
  );
  session = opened.session_id;
  // One config for the whole sitting; all 9 rounds go live at once.
  await rpc(
    'start_rapid_fire',
    [session, 5, 12],
    ['uuid', 'smallint', 'smallint'],
  );
  await identity(player);
  await rpc('join_session', [opened.code, 'Explorer', 'seed']);
});
// The single count applies to every round, so it is capped at the smallest
// lecture pool (9). Callers must pass count <= 9.
async function configuredRelease(count: number, seconds: number) {
  await identity(host);
  const opened = await rpc(
    'open_session',
    ['A', new Date(Date.now() + 75 * 60000).toISOString()],
    ['text', 'timestamptz'],
  );
  session = opened.session_id;
  await rpc(
    'start_rapid_fire',
    [session, count, seconds],
    ['uuid', 'smallint', 'smallint'],
  );
  await identity(player);
  await rpc('join_session', [opened.code, 'Explorer', 'seed']);
}
// Self-paced: play a whole round for `player` with correct (or wrong) answers
// and submit it. No instructor handoff.
async function completeRound(r: number, correct = true) {
  await identity(player);
  await rpc('start_round', [session, r], ['uuid', 'smallint']);
  await admin(
    `update public.attempts a set served_at=clock_timestamp(),answered_at=clock_timestamp(),
     option_id=(select (o->>'id')::bigint from public.release_questions q cross join lateral jsonb_array_elements(q.snapshot->'options') o
       where q.session_id=a.session_id and q.round_id=a.round_id and q.question_id=a.question_id and (o->>'is_correct')::boolean=$1 limit 1)
     where a.session_id=$2 and a.player_id=$3 and a.round_id=$4`,
    [correct, session, player, r],
  );
  await identity(player);
  await rpc('submit_round', [session, r], ['uuid', 'smallint']);
}
async function choose(seq: number, token: string | null) {
  return rpc(
    'submit_answer',
    [session, 1, seq, token],
    ['uuid', 'smallint', 'smallint', 'uuid'],
  );
}
async function finishAndRead() {
  // Solutions unlock only once the whole rapid fire is over.
  await identity(host);
  await rpc('end_session', [session], ['uuid']);
  await identity(player);
  return round('my_result');
}
async function fillAnswers(seconds = 6, correct = true) {
  await admin(
    `update public.attempts a set served_at='2026-01-01T00:00:00Z',answered_at='2026-01-01T00:00:00Z'::timestamptz+make_interval(secs=>$1),
  option_id=(select (o->>'id')::bigint from public.release_questions q cross join lateral jsonb_array_elements(q.snapshot->'options') o where q.session_id=a.session_id and q.round_id=a.round_id and q.question_id=a.question_id and (o->>'is_correct')::boolean=$2 limit 1) where a.session_id=$3 and player_id=$4`,
    [seconds, correct, session, player],
  );
  await identity(player);
}
async function ownToken(seq: number, correct = true) {
  const r = await admin(
    `select a.option_tokens[array_position(a.option_order,(o->>'id')::bigint)] token
  from public.attempts a join public.release_questions q using(session_id,round_id,question_id)
  cross join lateral jsonb_array_elements(q.snapshot->'options') o
  where a.session_id=$1 and a.player_id=$2 and a.seq=$3 and (o->>'is_correct')::boolean=$4 limit 1`,
    [session, player, seq, correct],
  );
  await identity(player);
  return String(r.rows[0].token);
}
describe('production PostgreSQL protocol', () => {
  it('freezes one correct and one incorrect opaque tempter token without revealing the key', async () => {
    const first = await round('start_round');
    noKey(first);
    expect(first.tempt_options).toHaveLength(2);
    expect(new Set(first.tempt_options).size).toBe(2);
    expect(
      first.tempt_options.every((t) => first.options.some((o) => o.id === t)),
    ).toBe(true);
    expect(first.tempt_options).toContain(await ownToken(first.seq));
    const resumed = await round('start_round');
    expect(resumed.tempt_options).toEqual(first.tempt_options);
    expect(resumed.options).toEqual(first.options);
    noKey(resumed);
    // Inspect every attempt server-side, including questions not served yet.
    const pairs = await admin(
      `select a.seq, a.tempt_tokens, a.option_tokens,
      a.option_tokens[array_position(a.option_order,(o->>'id')::bigint)] correct_token
      from public.attempts a join public.release_questions q using(session_id,round_id,question_id)
      cross join lateral jsonb_array_elements(q.snapshot->'options') o
      where a.session_id=$1 and a.player_id=$2 and (o->>'is_correct')::boolean`,
      [session, player],
    );
    expect(pairs.rows).toHaveLength(5);
    for (const row of pairs.rows) {
      const pair = row.tempt_tokens as string[];
      expect(pair).toHaveLength(2);
      expect(new Set(pair).size).toBe(2);
      expect(pair).toContain(row.correct_token);
      expect(
        pair.every((t) => (row.option_tokens as string[]).includes(t)),
      ).toBe(true);
    }
    await identity(player);
    const next = await choose(first.seq, first.tempt_options[0]);
    noKey(next);
    expect(next.seq).toBe(2);
    expect(next.tempt_options).toEqual(
      pairs.rows.find((r) => r.seq === 2)!.tempt_tokens,
    );
  });
  it('can assign either avatar the correct token and keeps the selection helper private', async () => {
    await round('start_round');
    await admin('select setseed(0.42)');
    const samples = await admin(
      `select public.pick_tempter_tokens(q.snapshot,a.option_order,a.option_tokens) pair,
      a.option_tokens[array_position(a.option_order,(o->>'id')::bigint)] correct_token
      from public.attempts a join public.release_questions q using(session_id,round_id,question_id)
      cross join lateral jsonb_array_elements(q.snapshot->'options') o
      cross join generate_series(1,32)
      where a.session_id=$1 and a.player_id=$2 and a.seq=1 and (o->>'is_correct')::boolean`,
      [session, player],
    );
    expect(
      new Set(
        samples.rows.map((r) =>
          (r.pair as string[]).indexOf(r.correct_token as string),
        ),
      ),
    ).toEqual(new Set([0, 1]));
    const permissions = await admin(
      `select has_function_privilege('authenticated','public.pick_tempter_tokens(jsonb,bigint[],uuid[])','execute') allowed`,
    );
    expect(permissions.rows[0].allowed).toBe(false);
  });
  it('omits the tempter pair from the payload when the instructor disables it', async () => {
    await identity(host);
    const opened = await rpc(
      'open_session',
      ['A', new Date(Date.now() + 75 * 60000).toISOString()],
      ['text', 'timestamptz'],
    );
    session = opened.session_id;
    await rpc(
      'start_rapid_fire',
      [session, 3, 12, false],
      ['uuid', 'smallint', 'smallint', 'boolean'],
    );
    await identity(player);
    await rpc('join_session', [opened.code, 'Explorer', 'seed']);
    const q = await round('start_round');
    // No hints on the wire; the frozen pair still exists server-side but unused.
    expect(q.tempt_options).toBeUndefined();
    const stored = await admin(
      'select count(*)::int n from public.attempts where session_id=$1 and tempt_tokens is not null',
      [session],
    );
    expect(stored.rows[0].n).toBe(3);
  });
  it('ships nine populated rounds and no domain allowlist', async () => {
    expect(
      (
        await admin(
          'select count(distinct round_id)::int n from public.questions',
        )
      ).rows[0].n,
    ).toBe(9);
    expect(
      (
        await admin('select domain from public.allowed_domains order by domain')
      ).rows.map((r) => r.domain),
    ).toEqual([]);
  });
  it('draws exactly the configured question count and serves one at a time', async () => {
    noKey(await round('start_round'));
    const { rows } = await admin(
      'select a.seq,a.served_at from public.attempts a order by seq',
    );
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.served_at)).toHaveLength(1);
  });
  it.each([1, 4, 9])(
    'freezes the same %i-question set for every student',
    async (count) => {
      await configuredRelease(count, 12);
      await round('start_round');
      const code = (
        await admin('select code from public.sessions where id=$1', [session])
      ).rows[0].code;
      await identity(outsider);
      await rpc('join_session', [code, 'Second student', 'seed']);
      noKey(await round('start_round'));
      const { rows } = await admin(
        'select player_id,array_agg(question_id order by question_id) ids from public.attempts where session_id=$1 group by player_id',
        [session],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].ids).toHaveLength(count);
      expect(rows[0].ids).toEqual(rows[1].ids);
    },
  );
  it('returns opaque tokens, no database question ID, and different tokens per student', async () => {
    const first = await round('start_round');
    noKey(first);
    expect(first).not.toHaveProperty('question_id');
    first.options.forEach((o) => expect(o.id).toMatch(/^[a-f0-9-]{36}$/));
    const code = (
      await admin('select code from public.sessions where id=$1', [session])
    ).rows[0].code;
    await identity(outsider);
    await rpc('join_session', [code, 'Second', 'seed']);
    const other = await round('start_round');
    expect(
      other.options.some((o) => first.options.some((x) => x.id === o.id)),
    ).toBe(false);
    await expect(choose(1, first.options[0].id)).rejects.toThrow(
      'invalid_option',
    );
    await expect(
      rpc(
        'submit_answer',
        [session, 1, 1, 1],
        ['uuid', 'smallint', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('does not exist');
  });
  it('keeps retry timestamps and tokens immutable and never changes an accepted answer', async () => {
    const first = await round('start_round');
    const resumed = await round('start_round');
    expect(resumed.options).toEqual(first.options);
    expect(resumed.served_at).toBe(first.served_at);
    const next = await choose(1, first.options[0].id);
    const retry = await choose(1, first.options[1].id);
    expect(retry.served_at).toBe(next.served_at);
    expect(retry.seq).toBe(2);
    const r = await admin(
      'select option_id=option_order[array_position(option_tokens,$1::uuid)] accepted from public.attempts where seq=1',
      [first.options[0].id],
    );
    expect(r.rows[0].accepted).toBe(true);
  });
  it('freezes content, correct answers and options against later bank edits', async () => {
    const first = await round('start_round');
    const q = (
      await admin('select question_id from public.attempts where seq=1')
    ).rows[0].question_id;
    const old = (
      await admin('select stem,explanation from public.questions where id=$1', [
        q,
      ])
    ).rows[0];
    await admin(
      "update public.questions set stem='CHANGED',explanation='CHANGED' where id=$1",
      [q],
    );
    await identity(player);
    const resumed = await round('start_round');
    expect(resumed.served_at).toBe(first.served_at);
    expect(resumed).toHaveProperty('stem', old.stem);
    const d = await finishAndRead();
    expect(d.questions[0]).toHaveProperty('stem', old.stem);
    expect(d.questions[0]).toHaveProperty('explanation', old.explanation);
    await admin(
      'update public.questions set stem=$1,explanation=$2 where id=$3',
      [old.stem, old.explanation, q],
    );
  });
  it('strips nested answer metadata and non-scalar cells before freezing content', async () => {
    await admin(
      `update public.questions set body='{"explanation":"SECRET","table_json":{"cols":["a"],"rows":[[1]],"is_correct":true,"explanation":"SECRET"}}'`,
    );
    await configuredRelease(1, 12);
    const q = await round('start_round');
    noKey(q);
    expect(JSON.stringify(q)).not.toContain('SECRET');
    await admin('update public.questions set body=null');
    expect(
      (
        await admin(
          `select public.safe_body('{"table_json":{"cols":["a"],"rows":[[{"explanation":"SECRET"}]]}}') b`,
        )
      ).rows[0].b,
    ).toEqual({});
  });
  it('rejects early timeout, unserved answers and foreign tokens', async () => {
    const first = await round('start_round');
    await expect(choose(1, null)).rejects.toThrow('answer_required');
    await expect(choose(2, first.options[0].id)).rejects.toThrow(
      'question_not_served',
    );
    await expect(
      choose(1, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('invalid_option');
    await expect(round('submit_round')).rejects.toThrow('round_incomplete');
  });
  it('gives each question its full duration despite an expired admission window', async () => {
    await configuredRelease(3, 10);
    const first = await round('start_round');
    await admin(
      "update public.round_releases set admission_closes_at=clock_timestamp()-interval '1 second' where session_id=$1",
      [session],
    );
    await identity(player);
    const next = await choose(1, first.options[0].id);
    expect(Date.parse(next.deadline) - Date.parse(next.served_at)).toBe(10000);
    expect(
      Date.parse(next.deadline) - Date.parse(next.server_now),
    ).toBeGreaterThan(9900);
  });
  it('opens all nine rounds live for the whole sitting, bounded by the session cutoff', async () => {
    await configuredRelease(5, 20);
    const { rows } = await admin(
      'select r.round_id,r.admission_closes_at=s.closes_at admit,r.closes_at=s.closes_at hard_end,r.status from public.round_releases r join public.sessions s on s.id=r.session_id where s.id=$1 order by r.round_id',
      [session],
    );
    expect(rows).toHaveLength(9);
    expect(
      rows.every((x) => x.admit && x.hard_end && x.status === 'live'),
    ).toBe(true);
  });
  it('rejects a new attempt after admission closes but permits resume', async () => {
    await round('start_round');
    const code = (
      await admin('select code from public.sessions where id=$1', [session])
    ).rows[0].code;
    await admin(
      "update public.round_releases set admission_closes_at=clock_timestamp()-interval '1 second' where session_id=$1",
      [session],
    );
    await identity(outsider);
    await rpc('join_session', [code, 'Late student', 'seed']);
    await expect(round('start_round')).rejects.toThrow('admission_closed');
    await identity(player);
    expect((await round('start_round')).seq).toBe(1);
  });
  it('catches up missed timeouts without restarting clocks or accepting a late choice', async () => {
    await configuredRelease(3, 10);
    const first = await round('start_round');
    await admin(
      "update public.attempts set served_at=clock_timestamp()-interval '21 seconds' where session_id=$1 and seq=1",
      [session],
    );
    await identity(player);
    const next = await choose(1, first.options[0].id);
    expect(next.seq).toBe(3);
    expect(
      Date.parse(next.deadline) - Date.parse(next.server_now),
    ).toBeLessThan(9100);
    const { rows } = await admin(
      'select option_id,answered_at-served_at elapsed from public.attempts where session_id=$1 and seq<3',
      [session],
    );
    expect(rows.every((r) => r.option_id === null)).toBe(true);
  });
  it('finalizes an entirely offline run and exposes only a receipt until release end', async () => {
    await configuredRelease(2, 10);
    await round('start_round');
    await admin(
      "update public.attempts set served_at=clock_timestamp()-interval '21 seconds' where session_id=$1 and seq=1",
      [session],
    );
    await identity(player);
    const complete = await round('start_round');
    expect(complete.round_complete).toBe(true);
    noKey(complete);
    noKey(await round('submit_round'));
    await expect(round('my_result')).rejects.toThrow('debrief_not_released');
    const d = await finishAndRead();
    expect(d.total_points).toBe(0);
  });
  it('keeps keys sealed even after a perfect early submission', async () => {
    await configuredRelease(3, 12);
    await round('start_round');
    for (let n = 1; n <= 3; n++) noKey(await choose(n, await ownToken(n)));
    expect(await round('submit_round')).toEqual({
      submitted: true,
      round_id: 1,
    });
    await expect(round('my_result')).rejects.toThrow('debrief_not_released');
    noKey(await rpc('student_state', [session], ['uuid']));
    const d = await finishAndRead();
    expect(d.total_points).toBeGreaterThan(470);
    expect(d.questions).toHaveLength(3);
  });
  it('lets a student self-pace round to round with no host action, solutions sealed until the end', async () => {
    await configuredRelease(1, 12);
    await completeRound(1);
    await expect(round('my_result')).rejects.toThrow('debrief_not_released');
    // A finished round just returns complete; walk straight into round 2 with
    // no instructor handoff; you cannot skip past an unfinished round.
    expect((await round('start_round')).round_complete).toBe(true);
    await rpc('start_round', [session, 2], ['uuid', 'smallint']);
    await expect(
      rpc('start_round', [session, 4], ['uuid', 'smallint']),
    ).rejects.toThrow('round_out_of_order');
    await expect(round('my_result')).rejects.toThrow('debrief_not_released');
    // Only when the whole rapid fire ends is the round 1 debrief recoverable.
    await identity(host);
    await rpc('end_session', [session], ['uuid']);
    await identity(player);
    const d = await round('my_result');
    expect(d.round_id).toBe(1);
    expect(d.questions[0]).toHaveProperty('stem');
    expect(d.questions[0]).toHaveProperty('options');
  });
  it('reveals the leaderboard by real name only once a player has finished every round', async () => {
    await configuredRelease(1, 12);
    await completeRound(1);
    // One round done is not the whole rapid fire: standings stay sealed.
    await expect(
      rpc('session_leaderboard', [session], ['uuid']),
    ).rejects.toThrow('leaderboard_not_released');
    for (let r = 2; r <= 9; r++) await completeRound(r);
    // Finished all nine: standings unlock, session still open.
    const board = await rpc<
      { rank: number; name: string; points: number; is_me: boolean }[]
    >('session_leaderboard', [session], ['uuid']);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      rank: 1,
      // The Google profile name, not the joined nickname 'Explorer'.
      name: 'Vishnu Gandarapu',
      is_me: true,
    });
    expect(board[0].points).toBeGreaterThan(0);
    // A non-member cannot read another session's standings.
    await identity(outsider);
    await expect(
      rpc('session_leaderboard', [session], ['uuid']),
    ).rejects.toThrow('not_session_member');
  });
  it('does not let a section match authorize another session', async () => {
    await identity(host);
    const other = await rpc(
      'open_session',
      ['A', new Date(Date.now() + 600000).toISOString()],
      ['text', 'timestamptz'],
    );
    await rpc(
      'start_rapid_fire',
      [other.session_id, 1, 12],
      ['uuid', 'smallint', 'smallint'],
    );
    await identity(player);
    for (const fn of ['start_round', 'my_result', 'submit_round'])
      await expect(
        rpc(fn, [other.session_id, 1], ['uuid', 'smallint']),
      ).rejects.toThrow('not_session_member');
    await expect(
      rpc('student_state', [other.session_id], ['uuid']),
    ).rejects.toThrow('not_session_member');
  });
  it('joining a second section preserves membership in the first', async () => {
    await identity(host);
    const other = await rpc(
      'open_session',
      ['B', new Date(Date.now() + 600000).toISOString()],
      ['text', 'timestamptz'],
    );
    await identity(player);
    await rpc('join_session', [other.code, 'Explorer', 'seed']);
    expect((await round('start_round')).seq).toBe(1);
  });
  it.each(['gmail.com', 'partner.example', 'example.edu.attacker.test'])(
    'admits any verified Google account at %s',
    async (domain) => {
      await admin('update auth.users set email=$1 where id=$2', [
        `student@${domain}`,
        player,
      ]);
      await identity(player);
      noKey(await round('start_round'));
      await admin(
        "update auth.users set email='student@example.edu' where id=$1",
        [player],
      );
    },
  );
  it('persists the join limiter across failed guesses and permits a later retry', async () => {
    await identity(outsider);
    for (let n = 0; n < 10; n++)
      expect(
        await rpc('join_session', ['ZZZZZZ', 'Student', 'seed']),
      ).toHaveProperty(
        'error',
        'Session unavailable. Check the code with your instructor.',
      );
    const code = (
      await admin('select code from public.sessions where id=$1', [session])
    ).rows[0].code;
    await identity(outsider);
    expect(await rpc('join_session', [code, 'Student', 'seed'])).toHaveProperty(
      'error',
      'Too many join attempts. Wait one minute.',
    );
    await admin(
      "update public.join_limits set window_start=clock_timestamp()-interval '61 seconds' where player_id=$1",
      [outsider],
    );
    await identity(outsider);
    expect(await rpc('join_session', [code, 'Student', 'seed'])).toHaveProperty(
      'session_id',
      session,
    );
  });
  it('requires verified Google identity on every RPC', async () => {
    await admin("update auth.users set raw_app_meta_data='{}' where id=$1", [
      player,
    ]);
    await identity(player);
    await expect(round('start_round')).rejects.toThrow('domain_not_allowed');
    await admin(
      `update auth.users set raw_app_meta_data='{"provider":"google"}',email_confirmed_at=null where id=$1`,
      [player],
    );
    await identity(player);
    await expect(round('start_round')).rejects.toThrow('domain_not_allowed');
    await admin('update auth.users set email_confirmed_at=now() where id=$1', [
      player,
    ]);
  });
  it('denies direct tables, private functions and anonymous RPCs', async () => {
    const { rows } = await admin(
      "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v') and (has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('authenticated',c.oid,'SELECT'))",
    );
    expect(rows).toEqual([]);
    const helpers = await admin(
      "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('assert_domain','assert_live','assert_member','safe_body','safe_table','snapshot_question','serve_pending','score_run','expire_run','finish_release','assert_draft_host') and has_function_privilege('authenticated',p.oid,'EXECUTE')",
    );
    expect(helpers.rows).toEqual([]);
    await identity(player, 'anon');
    await expect(round('start_round')).rejects.toThrow('permission denied');
    await expect(rpc('student_state', [session], ['uuid'])).rejects.toThrow(
      'permission denied',
    );
  });
  it('checks the signup hook for a Google provider', async () => {
    await identity(player, 'supabase_auth_admin');
    const event = (domain: string, provider = 'google') => ({
      user: { email: `a@${domain}`, app_metadata: { provider } },
    });
    expect(
      await rpc(
        'before_user_created',
        [event('students.example.edu')],
        ['jsonb'],
      ),
    ).toEqual({});
    expect(
      await rpc('before_user_created', [event('gmail.com')], ['jsonb']),
    ).toEqual({});
    expect(
      (
        await rpc(
          'before_user_created',
          [event('example.edu', 'email')],
          ['jsonb'],
        )
      ).error.http_code,
    ).toBe(403);
  });
  it('permits only the owner to start, end and report', async () => {
    await expect(round('round_report')).rejects.toThrow('host_only');
    await expect(rpc('end_session', [session], ['uuid'])).rejects.toThrow(
      'host_only',
    );
    await expect(rpc('instructor_state', [session], ['uuid'])).rejects.toThrow(
      'host_only',
    );
    await expect(
      rpc(
        'start_rapid_fire',
        [session, 1, 12],
        ['uuid', 'smallint', 'smallint'],
      ),
    ).rejects.toThrow('host_only');
  });
  it('revokes instructor access immediately when the email allowlist changes', async () => {
    await admin(
      "delete from public.instructor_emails where email='host@example.edu'",
    );
    await identity(host);
    await expect(rpc('end_session', [session], ['uuid'])).rejects.toThrow(
      'host_only',
    );
    await admin(
      "insert into public.instructor_emails values('host@example.edu')",
    );
  });
  it('scores exact speed/streaks with no extra second and no negative points', async () => {
    await configuredRelease(9, 12);
    await round('start_round');
    await fillAnswers();
    await admin(
      'update public.attempts set option_id=null where session_id=$1 and seq=7',
      [session],
    );
    await admin(
      "update public.attempts set answered_at=served_at+interval '12 seconds' where session_id=$1 and seq=9",
      [session],
    );
    await identity(player);
    await round('submit_round');
    const d = await finishAndRead();
    expect(d.questions.map((q) => q.points)).toEqual([
      125, 125, 150, 150, 150, 188, 0, 125, 0,
    ]);
  });
  it('logs accurate per-student and aggregate metrics with a strict halfway boundary', async () => {
    await configuredRelease(4, 20);
    await round('start_round');
    await fillAnswers(10);
    await admin(
      "update public.attempts set answered_at=served_at+interval '9.999 seconds' where session_id=$1 and seq=1",
      [session],
    );
    await admin(
      "update public.attempts set option_id=null,answered_at=served_at+interval '20 seconds' where session_id=$1 and seq=4",
      [session],
    );
    await identity(player);
    await round('submit_round');
    await finishAndRead();
    await identity(host);
    const report = (await round('round_report')) as unknown as {
      half_time_seconds: number;
      students: Record<string, number>[];
      summary: Record<string, number>;
      questions: Record<string, number>[];
    };
    expect(report.half_time_seconds).toBe(10);
    expect(report.students[0].correct_count).toBe(3);
    expect(report.students[0].timeout_count).toBe(1);
    expect(report.students[0].accuracy_percent).toBe(75);
    expect(report.students[0].answers_under_half_time).toBe(1);
    expect(report.students[0].average_answer_seconds).toBeCloseTo(49.999 / 4);
    expect(report.summary.average_round_answer_seconds).toBeCloseTo(49.999);
    expect(report.summary.average_accuracy_percent).toBe(75);
    expect(
      report.questions.reduce((n, q) => n + q.students_under_half_time, 0),
    ).toBe(1);
  });
  it('records every wrong answer as zero points and counts it separately from timeouts', async () => {
    await configuredRelease(4, 20);
    await round('start_round');
    await fillAnswers(2, false);
    await round('submit_round');
    const d = await finishAndRead();
    expect(d.total_points).toBe(0);
    const r = await admin(
      'select wrong_count,timeout_count,under_half_count from public.round_runs where session_id=$1',
      [session],
    );
    expect(r.rows[0]).toEqual({
      wrong_count: 4,
      timeout_count: 0,
      under_half_count: 4,
    });
  });
  it('finalizes a partial run at session end and seals solutions until then', async () => {
    await configuredRelease(3, 20);
    await round('start_round');
    await choose(1, await ownToken(1));
    // Mid-round, session still live: no solutions.
    await expect(round('my_result')).rejects.toThrow('debrief_not_released');
    // Ending the session force-finalizes the partial run exactly once.
    await identity(host);
    await rpc('end_session', [session], ['uuid']);
    await identity(player);
    const r = await admin(
      'select correct_count,timeout_count from public.round_runs where session_id=$1 and round_id=1',
      [session],
    );
    expect(r.rows[0]).toEqual({ correct_count: 1, timeout_count: 2 });
    const d = await round('my_result');
    expect(d.total_points).toBeGreaterThan(0);
    expect(d.questions).toHaveLength(3);
  });
  it('closes expired sessions and makes their saved results recoverable', async () => {
    await round('start_round');
    await admin(
      "update public.sessions set closes_at=clock_timestamp()-interval '1 second' where id=$1",
      [session],
    );
    await identity(player);
    const state = await rpc('student_state', [session], ['uuid']);
    expect(state).toHaveProperty('status', 'closed');
    expect(state).toHaveProperty('results', [1]);
    expect((await round('my_result')).total_points).toBe(0);
    await expect(round('start_round')).rejects.toThrow('session_closed');
  });
  it('reports one shared config and student progress to the host', async () => {
    await completeRound(1);
    await identity(host);
    const st = (await rpc(
      'instructor_state',
      [session],
      ['uuid'],
    )) as unknown as {
      config: { question_count: number; seconds_per_question: number };
      students_joined: number;
      students_done: number;
      min_available: number;
    };
    expect(st.config).toMatchObject({
      question_count: 5,
      seconds_per_question: 12,
    });
    expect(st.students_joined).toBe(1);
    expect(st.students_done).toBe(0);
    expect(st.min_available).toBe(9);
  });
  it('validates the single configuration and refuses to start twice', async () => {
    await identity(host);
    const opened = await rpc(
      'open_session',
      ['A', new Date(Date.now() + 75 * 60000).toISOString()],
      ['text', 'timestamptz'],
    );
    const start = (count: number, seconds: number) =>
      rpc(
        'start_rapid_fire',
        [opened.session_id, count, seconds],
        ['uuid', 'smallint', 'smallint'],
      );
    for (const count of [0, 301])
      await expect(start(count, 12)).rejects.toThrow('invalid_question_count');
    for (const seconds of [0, 121])
      await expect(start(1, seconds)).rejects.toThrow('invalid_seconds');
    // One count must fit every round; the smallest lecture pool (9) caps it.
    await expect(start(10, 12)).rejects.toThrow('insufficient_question_pool');
    await start(1, 12);
    await expect(start(1, 12)).rejects.toThrow('already_started');
  });
  it('enforces nonnegative scores and complete MCQ shape at the database layer', async () => {
    await round('start_round');
    await expect(
      admin('update public.attempts set points=-1 where seq=1'),
    ).rejects.toThrow('nonnegative_points');
    await expect(
      admin('update public.round_runs set total_points=-1'),
    ).rejects.toThrow('nonnegative_total_points');
    await admin('begin');
    await db.exec(
      "insert into public.questions(round_id,display_type,difficulty,stem,explanation) values(1,'concept','easy','Invalid','Invalid')",
    );
    await expect(db.exec('commit')).rejects.toThrow(
      'question_requires_four_options_one_correct',
    );
    await db.exec('rollback');
  });
});

describe('instructor session report', () => {
  const report = async () =>
    parseSessionReport(await rpc('session_report', [session], ['uuid']));
  it('requires the assigned host and instructor allowlist, and rejects live sessions', async () => {
    await expect(report()).rejects.toThrow('host_only');
    await admin(
      "insert into public.instructor_emails values('outsider@example.edu')",
    );
    await identity(outsider);
    await expect(report()).rejects.toThrow('host_only');
    await admin(
      "delete from public.instructor_emails where email='outsider@example.edu'",
    );
    await identity(host);
    await expect(report()).rejects.toThrow('report_available_after_session');
    await admin(
      "delete from public.instructor_emails where email='host@example.edu'",
    );
    await identity(host);
    await expect(report()).rejects.toThrow('host_only');
    await admin(
      "insert into public.instructor_emails values('host@example.edu')",
    );
  });
  it('ranks ties by total time and aggregates across submitted rounds with N = 5', async () => {
    // Controlled persisted results isolate aggregation from already-tested scoring.
    await admin(
      `insert into public.players(id,section,nickname,avatar_seed) values
      ($1,'A','Host nickname','seed'),($2,'A','Other nickname','seed')`,
      [host, outsider],
    );
    await admin(
      `insert into public.session_members(session_id,player_id) values($1,$2),($1,$3)`,
      [session, host, outsider],
    );
    await admin(
      `update auth.users set raw_user_meta_data='{"full_name":"  ","name":"Fallback Name"}' where id=$1`,
      [outsider],
    );
    await admin(
      `insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question,submitted_at,total_points,total_time,best_streak,correct_count,wrong_count,timeout_count,under_half_count) values
      ($1,$2,1,5,12,now(),200,12,3,3,1,1,2),
      ($1,$2,2,5,12,now(),100,8,2,2,1,2,1),
      ($1,$3,1,5,12,now(),300,25,4,4,1,0,4),
      ($1,$4,1,5,12,now(),300,20,5,5,0,0,5)`,
      [session, player, outsider, host],
    );
    await identity(host);
    await rpc('end_session', [session], ['uuid']);
    const data = await report();
    expect(data.question_count).toBe(5);
    expect(data.students.map((s) => s.rank)).toEqual([1, 1, 3]);
    expect(data.students[2].player_id).toBe(outsider);
    expect(data.students[2].name).toBe('Fallback Name');
    expect(data.students.find((s) => s.player_id === player)).toMatchObject({
      name: 'Vishnu Gandarapu',
      total_points: 300,
      best_streak: 3,
      rounds_completed: 2,
      correct_count: 5,
      wrong_count: 2,
      timeout_count: 3,
      total_answer_seconds: 20,
      accuracy_percent: 50,
      average_answer_seconds: 2,
      answers_under_half_time: 3,
    });
    expect(data.summary).toMatchObject({
      submitted_students: 3,
      students_joined: 3,
      average_score: 300,
      average_wrong_count: 1,
      average_timeout_count: 1,
      answers_under_half_time: 12,
      students_with_under_half_answers: 3,
    });
    expect(data.summary.average_correct_count).toBeCloseTo(14 / 3);
    expect(data.summary.average_accuracy_percent).toBeCloseTo(230 / 3);
    expect(data.summary.average_answer_seconds).toBeCloseTo(11 / 3);
    expect(data.summary.average_total_answer_seconds).toBeCloseTo(65 / 3);
    // Ranking prioritizes points even when a lower scorer answered faster.
    await admin(
      'update public.round_runs set total_points=299,total_time=1 where session_id=$1 and player_id=$2',
      [session, host],
    );
    await identity(host);
    expect((await report()).students.map((s) => s.player_id)).toEqual([
      player,
      outsider,
      host,
    ]);
    await admin("update auth.users set raw_user_meta_data='{}' where id=$1", [
      outsider,
    ]);
    await identity(host);
    expect(
      (await report()).students.find((s) => s.player_id === outsider)?.name,
    ).toBe('Other nickname');
  });
  it('finalizes unfinished runs after the automatic cutoff and remains idempotent', async () => {
    await round('start_round');
    await admin(
      "update public.sessions set closes_at=clock_timestamp()-interval '1 second' where id=$1",
      [session],
    );
    await identity(host);
    const data = await report();
    expect(data.students[0]).toMatchObject({
      rounds_completed: 1,
      correct_count: 0,
      wrong_count: 0,
      timeout_count: 5,
      accuracy_percent: 0,
    });
    expect(await report()).toEqual(data);
    const detail = parseRoundReport(await round('round_report'));
    expect(detail.students[0].accuracy_percent).toBe(0);
  });
  it('returns zero counts and null averages for joined students without submitted runs', async () => {
    await identity(host);
    await rpc('end_session', [session], ['uuid']);
    const data = await report();
    expect(data.students).toEqual([]);
    expect(data.summary.submitted_students).toBe(0);
    expect(data.summary.students_joined).toBe(1);
    expect(data.summary.answers_under_half_time).toBe(0);
    for (const [key, value] of Object.entries(data.summary)) {
      if (key.startsWith('average_')) expect(value).toBeNull();
    }
    const permissions = await admin(
      "select has_function_privilege('anon','public.session_report(uuid)','execute') allowed",
    );
    expect(permissions.rows[0].allowed).toBe(false);
  });
});

type Review = {
  config: { question_count: number; seconds_per_question: number };
  rounds: {
    id: number;
    available: number;
    questions: {
      question_id: number;
      stem: string;
      explanation: string;
      edited: boolean;
      options: { id: number; body: { text: string }; is_correct: boolean }[];
    }[];
  }[];
};
describe('question review before going live', () => {
  let draft: string;
  let code: string;
  const prepare = (count: number, seconds = 12) =>
    rpc<Review>(
      'prepare_rapid_fire',
      [draft, count, seconds],
      ['uuid', 'smallint', 'smallint'],
    );
  const start = (count: number, seconds = 12) =>
    rpc(
      'start_rapid_fire',
      [draft, count, seconds],
      ['uuid', 'smallint', 'smallint'],
    );
  const edit = (
    roundId: number,
    q: Review['rounds'][0]['questions'][0],
    patch: {
      stem?: string;
      texts?: string[];
      correct?: number;
      explanation?: string;
    },
  ) =>
    rpc<Review>(
      'edit_draft_question',
      [
        draft,
        roundId,
        q.question_id,
        patch.stem ?? q.stem,
        JSON.stringify(
          q.options.map((o, i) => ({
            id: o.id,
            text: patch.texts?.[i] ?? o.body.text,
          })),
        ),
        patch.correct ?? q.options.find((o) => o.is_correct)!.id,
        patch.explanation ?? q.explanation,
      ],
      ['uuid', 'smallint', 'bigint', 'text', 'jsonb', 'bigint', 'text'],
    );
  beforeEach(async () => {
    await identity(host);
    const opened = await rpc(
      'open_session',
      ['A', new Date(Date.now() + 60 * 60000).toISOString()],
      ['text', 'timestamptz'],
    );
    draft = opened.session_id;
    code = opened.code;
  });

  it('draws a reviewable draft with answers for the host, not a started session', async () => {
    const review = await prepare(3);
    expect(review.rounds).toHaveLength(9);
    for (const r of review.rounds) {
      expect(r.questions).toHaveLength(3);
      for (const q of r.questions)
        expect(q.options.filter((o) => o.is_correct)).toHaveLength(1);
    }
    const state = await rpc<{
      config: unknown;
      draft: { question_count: number };
    }>('instructor_state', [draft], ['uuid']);
    expect(state.config).toBeNull();
    expect(state.draft.question_count).toBe(3);
    await identity(player);
    await expect(rpc('draft_review', [draft], ['uuid'])).rejects.toThrow(
      'host_only',
    );
    await expect(
      rpc(
        'edit_draft_question',
        [draft, 1, 1, 'x', '[]', 1, 'x'],
        ['uuid', 'smallint', 'bigint', 'text', 'jsonb', 'bigint', 'text'],
      ),
    ).rejects.toThrow('host_only');
  });

  it('serves and grades the edited question without touching the shared bank', async () => {
    const review = await prepare(1);
    const q = review.rounds[0].questions[0];
    const wrong = q.options.find((o) => !o.is_correct)!;
    const edited = await edit(1, q, {
      stem: 'Edited stem?',
      texts: ['Alpha', 'Beta', 'Gamma', 'Delta'],
      correct: wrong.id,
      explanation: 'Edited explanation.',
    });
    const after = edited.rounds[0].questions[0];
    expect(after.edited).toBe(true);
    expect(after.stem).toBe('Edited stem?');
    expect(after.options.map((o) => o.body.text)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    expect(after.options.find((o) => o.is_correct)!.id).toBe(wrong.id);
    const bank = await admin('select stem from public.questions where id=$1', [
      q.question_id,
    ]);
    expect(bank.rows[0].stem).toBe(q.stem);
    const correct = await admin(
      'select is_correct from public.options where id=$1',
      [wrong.id],
    );
    expect(correct.rows[0].is_correct).toBe(false);

    await start(1);
    await identity(player);
    await rpc('join_session', [code, 'Explorer', 'seed']);
    const served = await rpc('start_round', [draft, 1], ['uuid', 'smallint']);
    noKey(served);
    expect((served as unknown as { stem: string }).stem).toBe('Edited stem?');
    // Choosing the newly-correct option scores; the bank's old key would not.
    const chosen = await admin(
      `select a.option_tokens[array_position(a.option_order,$1::bigint)] token from public.attempts a
       where a.session_id=$2 and a.round_id=1`,
      [wrong.id, draft],
    );
    await identity(player);
    await rpc(
      'submit_answer',
      [draft, 1, 1, chosen.rows[0].token],
      ['uuid', 'smallint', 'smallint', 'uuid'],
    );
    const run = await admin(
      'select correct_count from public.round_runs where session_id=$1 and round_id=1',
      [draft],
    );
    expect(run.rows[0].correct_count).toBe(1);
  });

  it('keeps edits across a settings change but redraws when the count changes', async () => {
    const q = (await prepare(2)).rounds[0].questions[0];
    await edit(1, q, { stem: 'Kept?' });
    const sameCount = await prepare(2, 30);
    expect(sameCount.config.seconds_per_question).toBe(30);
    expect(sameCount.rounds[0].questions.map((x) => x.stem)).toContain('Kept?');
    const redrawn = await prepare(3);
    expect(redrawn.rounds[0].questions).toHaveLength(3);
    expect(redrawn.rounds[0].questions.map((x) => x.stem)).not.toContain(
      'Kept?',
    );
  });

  it('swaps within the same lecture pool, refuses when it is exhausted, and resets edits', async () => {
    const review = await prepare(2);
    const r = review.rounds[0];
    const before = r.questions.map((x) => x.question_id);
    const swapped = await rpc<Review>(
      'swap_draft_question',
      [draft, r.id, before[0]],
      ['uuid', 'smallint', 'bigint'],
    );
    const now = swapped.rounds[0].questions.map((x) => x.question_id);
    expect(now).toHaveLength(2);
    expect(now).not.toContain(before[0]);
    expect(now).toContain(before[1]);
    const bankRound = await admin(
      'select round_id from public.questions where id=any($1)',
      [now],
    );
    expect(bankRound.rows.every((x) => x.round_id === r.id)).toBe(true);

    const smallest = review.rounds.reduce((a, b) =>
      b.available < a.available ? b : a,
    );
    const full = await prepare(smallest.available);
    const pool = full.rounds.find((x) => x.id === smallest.id)!;
    await expect(
      rpc(
        'swap_draft_question',
        [draft, pool.id, pool.questions[0].question_id],
        ['uuid', 'smallint', 'bigint'],
      ),
    ).rejects.toThrow('no_replacement');

    const q = full.rounds[0].questions[0];
    await edit(full.rounds[0].id, q, { stem: 'Temporary' });
    const reset = await rpc<Review>(
      'reset_draft_question',
      [draft, full.rounds[0].id, q.question_id],
      ['uuid', 'smallint', 'bigint'],
    );
    const restored = reset.rounds[0].questions.find(
      (x) => x.question_id === q.question_id,
    )!;
    expect(restored.stem).toBe(q.stem);
    expect(restored.edited).toBe(false);
  });

  it.each([
    ['invalid_stem', { stem: '   ' }],
    ['invalid_explanation', { explanation: '' }],
    ['invalid_option_text', { texts: ['', 'b', 'c', 'd'] }],
    ['invalid_correct_option', { correct: 999999 }],
  ])('rejects an edit with %s', async (message, patch) => {
    const q = (await prepare(1)).rounds[0].questions[0];
    await expect(edit(1, q, patch)).rejects.toThrow(message);
  });

  it('rejects options that do not match the question exactly', async () => {
    const q = (await prepare(1)).rounds[0].questions[0];
    await expect(
      rpc(
        'edit_draft_question',
        [
          draft,
          1,
          q.question_id,
          'Stem',
          JSON.stringify(
            q.options.slice(0, 3).map((o) => ({ id: o.id, text: 'x' })),
          ),
          q.options[0].id,
          'Why',
        ],
        ['uuid', 'smallint', 'bigint', 'text', 'jsonb', 'bigint', 'text'],
      ),
    ).rejects.toThrow('invalid_options');
  });

  it('gives back review time on start and locks the draft once live', async () => {
    await prepare(2);
    const opened = await admin(
      'select closes_at from public.sessions where id=$1',
      [draft],
    );
    await admin(
      "update public.round_releases set prepared_at=prepared_at-interval '20 minutes' where session_id=$1",
      [draft],
    );
    await identity(host);
    await start(2);
    const live = await admin(
      'select closes_at,status from public.sessions where id=$1',
      [draft],
    );
    expect(live.rows[0].status).toBe('live');
    const added =
      (new Date(live.rows[0].closes_at as string).getTime() -
        new Date(opened.rows[0].closes_at as string).getTime()) /
      60000;
    expect(added).toBeGreaterThanOrEqual(19.9);
    const state = await rpc<{
      config: { question_count: number };
      draft: unknown;
    }>('instructor_state', [draft], ['uuid']);
    expect(state.config.question_count).toBe(2);
    expect(state.draft).toBeNull();
    await expect(rpc('draft_review', [draft], ['uuid'])).rejects.toThrow(
      'already_started',
    );
    await expect(prepare(2)).rejects.toThrow('already_started');
  });

  it('starting with a different count than the draft redraws instead of keeping it', async () => {
    const q = (await prepare(2)).rounds[0].questions[0];
    await edit(1, q, { stem: 'Discarded?' });
    await start(3);
    const rows = await admin(
      "select count(*)::int n, bool_or(snapshot->>'stem'='Discarded?') kept from public.release_questions where session_id=$1 and round_id=1",
      [draft],
    );
    expect(rows.rows[0]).toEqual({ n: 3, kept: false });
  });
});
