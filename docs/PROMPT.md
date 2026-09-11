# Codex build prompt — "The Lost Schema"

> **Model:** pick **GPT-6 Astra** (the newest, strongest of the listed models) for this build —
> the schema, security functions and no-leak invariants are correctness-critical and reward the
> deepest reasoning. Set reasoning effort to **high**. If Astra is rate-limited, fall back to
> **Default** (it routes to the recommended set) or the highest **GPT-5.6** you can select; keep
> the model on its strongest setting for the database and RPC work.
>
> **How to use:** paste everything below the line as your first message. It is self-contained —
> Codex needs only this, not any other document. Work milestone by milestone; run and show each
> before moving on.

---

## Role & goal

You are building a production web game, **The Lost Schema**: a 2D treasure-hunt wrapper around
rapid-fire SQL multiple-choice questions, run in a university DBMS lab. It must:

- support **120 students playing at the same time**,
- run entirely on **free tiers**,
- fit the whole **nine-round sitting in ~75 minutes**,
- be maintainable by a small teaching team fluent in PostgreSQL.

Build **incrementally**. After each milestone, stop, run it, and show me what works before moving
on. Do not scaffold the whole thing in one shot. Ask before adding anything that would leave a
free tier.

## Absolute rules (these are the point of the app — never violate)

1. **No feedback during a round.** While a student plays the 30-question rapid fire, show **no**
   correct/wrong indication, **no** hints, **no** option-eliminations, **no** running score. The
   avatar advances one tile per *answered* question regardless of correctness, so movement leaks
   nothing.
2. **The answer key never reaches the browser until the round is submitted.** Questions are served
   with no `is_correct`, no `explanation`, and no field that identifies the right option.
   Correctness, reasons, score, streak and leaderboard appear only in a **single end-of-round
   debrief**, after one `submit_round` call. This must be covered by an automated test.
3. **One session runs all nine rounds.** A single session plays Round 1 → Round 9 back to back
   (rounds map to lectures 1–9 by content, but are played as one event, not one per lab). Each
   round is its own sealed rapid fire with its own debrief; the instructor drives the handoff so
   all players stay in step. A **cumulative** leaderboard (sum across rounds) shows between rounds
   and is final after Round 9. One `closes_at` covers the whole sitting.
4. **Access only during the lab.** The game works only while an instructor-opened session is
   `live` and before its `closes_at`. Outside that window a signed-in student sees "No lab is
   running right now" and every game call is refused **by the database**, not just the UI. When a
   session closes, open tabs clear all question content from memory.
5. **All questions are single-answer MCQs:** exactly four options, exactly one correct.
6. **Timing is server-authoritative and tight: 12 seconds per MCQ.** Enforced by comparing the
   server-side `served_at` to `now()` at submit, with a 1-second latency grace. The client ring
   timer is display-only. (270 MCQs × 12 s ≈ 54 min answering; with 15 s story intros, 45 s
   per-round debriefs and short breaks the sitting is ~75 min.)
7. **Domain-locked sign-in.** Only the college's Google Workspace accounts may play.

## Tech stack (use exactly this)

- **Frontend:** Vite + React + TypeScript, strict mode, ESLint + Prettier.
- **2D map/trail:** Phaser 4 (`phaser@^4.2`) mounted inside a React component. Tilemaps authored
  in Tiled; render the 30-tile trail, avatar movement tweens, per-round themes.
- **DB + API + Auth + Realtime + Storage:** Supabase (free tier). Postgres is the source of truth.
  Game logic lives in **PL/pgSQL `SECURITY DEFINER` functions** called via `supabase.rpc(...)`.
  No scoring or answer keys in the client.
- **Auth:** Supabase Auth, Google provider, scopes `openid email profile` only (no Google
  verification, no 100-test-user cap). Restrict to the allowed domain(s) with the **Before User
  Created** auth hook (Postgres function) AND re-check the domain inside every game RPC.
- **Realtime:** Supabase Realtime Broadcast, **only** for host events (`session_opened`,
  `round_started`, `session_ended`). No per-answer broadcasts. Provide a 3-second polling fallback
  for when campus Wi-Fi blocks WebSockets.
- **Hosting:** Cloudflare Pages (static). All round art/audio served from Pages, never from
  Supabase, to protect Supabase egress.
- **SQL highlighting:** run Shiki at **import time**; store the highlighted HTML on the question.
  No highlighter in the student bundle.
- **Diagrams:** ER-diagram questions use pre-rendered SVG in a **private** Storage bucket, served
  via 60-second signed URLs during a live session only. Public theme art and avatars in a public
  bucket.
- **Secrets:** via `.env` / Cloudflare + Supabase settings. Never hard-code keys. Commit a
  `.env.example`.

## Data model (create as migrations)

```sql
create table rounds (
  id smallint primary key,               -- 1..9
  lecture text not null,                  -- 'L1'..'L8','L10'
  theme_key text not null unique,         -- 'vault-of-keys'
  title text not null
);

create table questions (
  id bigint generated always as identity primary key,
  round_id smallint not null references rounds,
  display_type text not null check (display_type in
    ('concept','code_read','predict_result','reverse_query',
     'spot_bug','fill_blank','diagram','visual')),
  difficulty text not null check (difficulty in ('easy','medium','hard')),
  stem text not null,
  body jsonb,                             -- highlighted code html, tables, svg ref
  explanation text not null,              -- shown only at debrief
  lock_order boolean not null default false
);

create table options (
  id bigint generated always as identity primary key,
  question_id bigint not null references questions on delete cascade,
  body jsonb not null,
  is_correct boolean not null,            -- NEVER selected to the client pre-submit
  misconception text                      -- null only on the correct option
);
create unique index one_correct_option on options (question_id) where is_correct;

create table players (
  id uuid primary key references auth.users,
  section text not null,
  nickname text not null,
  avatar_seed text not null
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,               -- 6 letters
  section text not null,
  host uuid not null references auth.users,
  status text not null default 'closed'
    check (status in ('closed','lobby','live')),
  current_round smallint references rounds, -- which of the 9 is live now
  started_at timestamptz,
  closes_at timestamptz                     -- hard end time for the whole sitting
);

create table attempts (
  session_id uuid not null references sessions,
  player_id uuid not null references players,
  round_id smallint not null references rounds,        -- which of the 9
  seq smallint not null check (seq between 1 and 30),  -- resets each round
  question_id bigint not null references questions,
  option_order bigint[] not null,          -- shuffled option ids as served
  served_at timestamptz not null default now(),
  answered_at timestamptz,
  option_id bigint references options,      -- what they picked
  points smallint not null default 0,       -- filled at submit_round
  primary key (session_id, player_id, round_id, seq)
);
```

Enable RLS on every table. `revoke all on questions, options, attempts, sessions from anon,
authenticated;` — students touch data only through the RPCs below.

## Server functions (PL/pgSQL, `SECURITY DEFINER`, `set search_path = public`)

- `assert_live(p_session uuid) returns sessions` — the gate. Raises `session_closed` unless
  `status='live' and now() < closes_at`; raises `not_in_this_section` unless the caller
  (`auth.uid()`) is a player in that section. **Every game function calls this first.**
- `join_session(code text, nickname text, avatar_seed text)` — lobby join; validates domain and
  section; upserts the player.
- `start_round(p_session uuid, p_round smallint)` — for the live round, draws this player's 30
  questions from that round's pool (see draw rules), inserts 30 `attempts` rows with shuffled
  `option_order` and `served_at`, returns **question 1 only, without the key**. Refuses if
  `p_round <> sessions.current_round`.
- `next_question(p_session uuid, p_round smallint)` — returns the next unanswered seq's stem +
  options in `option_order`; **no `is_correct`, no `explanation`**.
- `submit_answer(p_session uuid, p_round smallint, seq smallint, option_id bigint)` — records the
  choice and `answered_at`; returns the **next question only** (never correctness). Marks a
  submission after `served_at + 12s + 1s grace` as a timeout.
- `submit_round(p_session uuid, p_round smallint)` — the **only** function that computes and
  reveals, for the round just played: scores every attempt (formula below), computes streaks, and
  returns the debrief (per-question chosen option, correct option, explanation, points; plus round
  totals, streak, and the player's **cumulative** leaderboard position).
- Host functions (host-only, checked against `sessions.host`): `open_session`, `go_live(p_round)`
  (advance `current_round` and broadcast so all players start together), `end_session`. The host
  walks the session Round 1 → 9, releasing each after a break.

Scoring (in `submit_round`, server-side only):

```
seconds_left = greatest(0, 12 - extract(epoch from (answered_at - served_at)))
points       = correct ? round((100 + 50 * seconds_left / 12) * streak_mult) : 0
streak_mult  = 1.0 base; 1.2 after 3 correct in a row; 1.5 after 6 in a row
tiebreak     = lower total answered time
```

## Question draw rules

Each round has a pool of ~45 (15 easy / 20 medium / 10 hard). Each player gets **30**: leg 1 = 10
easy, leg 2 = 10 medium, leg 3 = 4 medium + 6 hard (difficulty climbs along the trail). Draw per
player; shuffle option order per question unless `lock_order` is set (ordered numeric answers).
Different players get different subsets and orders.

## The nine rounds (theme, guide, content)

Build Round 1 fully first, then reuse the same components with different theme packs (tilemap,
palette, guide sprite, 3 story panels, unlockable avatar outfit).

1. **The Vault of Keys** — L1 — EAR, schema, primary/candidate/super/foreign keys, NOT NULL,
   UNIQUE, integrity, datatypes. Guide: Keysmith Kavya.
2. **Guild City** — L2 — DDL/DML/TCL/DCL commands. Guide: Foreman Arjun.
3. **Dune Dig / The Cipher Lock** — L3 — SELECT, DISTINCT, WHERE, IN, LIKE, EXISTS, wildcards,
   logical ops, LIMIT/OFFSET. Guide: Archaeologist Meera. **Signature mechanic: password cracking.**
4. **The Alchemist's Workshop** — L4 — numeric/date/string/NULL/aggregate functions. Guide:
   Alchemist Zoya.
5. **Pirate Harbour / The Card Table** — L5 — GROUP BY, multi-column grouping, HAVING vs WHERE,
   grouping errors, CASE with aggregates. Guide: Captain Rafi. **Signature mechanic: pack of cards.**
6. **Orbit Grand Prix** — L6 — window functions (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD), moving
   averages, execution order. Guide: RANK-7 (robot).
7. **The Nesting Temple** — L7 — subqueries in SELECT/FROM/WHERE; correlated vs non-correlated.
   Guide: Keeper Tenzin.
8. **Noir Bureau** — L8 — INNER/LEFT/RIGHT/FULL/SELF joins, Cartesian mistakes, WHERE vs ON,
   multi-table joins, UNION/UNION ALL/INTERSECT. Guide: Inspector Iqbal.
9. **The Cartographer's Finale** — L10 — ER modelling: notation, entity/attribute/relationship,
   cardinality, participation, weak entities. Guide: Cartographer Noor.

Each `display_type` is a React card component: `concept`, `code_read`, `predict_result`,
`reverse_query`, `spot_bug`, `fill_blank`, `diagram`, `visual`. Every round mixes ≥ 4 types.

**Show tables as tables.** Any card that needs data (`predict_result`, `reverse_query`, and any
`visual` with a grid) renders a real HTML `<table>` from `body.table_json` (`{cols:[...],
rows:[[...]]}`) — data is **never** mashed into the stem text. Options that are themselves result
sets render as mini-tables, not sentences. The **stem is one short, catchy line** above the table
(a hook, e.g. "Who came in pairs?"), never a paragraph: the table carries the data, the words
carry the question.

**12-second card discipline:** keep `code_read` and `predict_result` cards short (≤ 5 code lines,
≤ 4×4 tables) and rate them easy/medium; lean the harder slots on `concept`, `fill_blank`,
`reverse_query`. No round should be code-heavy under the shorter clock.

## Signature mechanics (still plain MCQs, still no mid-round feedback)

- **Round 5 — The Card Table.** A fixed 52-card deck `deck(suit, rank, color, val)` is the
  grouping dataset. Each question deals a small hand and asks a GROUP BY / HAVING / CASE question
  (e.g. "which query returns only ranks dealt more than once?"). Distractors catch
  aggregate-in-WHERE, DISTINCT-instead-of-count, and wrong grouping column.
- **Round 3 — The Cipher Lock.** Password cracking as pattern-matching MCQs over a candidate word
  list `leads(word)`. The clue is in the stem, not a hint, e.g. "8 letters, starts S, ends n →
  which WHERE keeps only those?" with `LIKE 'S______n'` correct and distractors `S%n`, `S_n`,
  `%S%n%`. Every card is self-contained; the "lock opening" is only a debrief animation.

## Instructor console (separate authenticated route)

- Create/open a session for a section; set `closes_at`; **Go live** to release each round Round 1
  → 9; **End**.
- Live view: counts only — how many joined, how many submitted the current round. No answers.
- After the sitting: cumulative leaderboard, per-question accuracy and median time, and a
  **misconception report** (counts per wrong option's `misconception`). CSV export of all.
- Projector view: big cumulative leaderboard showing avatar nicknames only (never real names),
  polling a view every 5 s.

## Authoring pipeline

A Node import script reads a Google Sheet / CSV with columns:
`round, qid, display_type, difficulty, bloom, stem, code, table_json, image, option_a..d,
correct, misconception_a..d, explanation, lock_order, creator, reviewer, status`.
It **validates** every row against the 12 s clock (stem ≤ 20 words, code ≤ 5 lines, tables ≤ 4×4,
options ≤ 10 words, exactly one correct), runs Shiki on code, and upserts only rows marked
`Ready`. It also enforces **tables-as-tables**: for `predict_result` / `reverse_query` / grid
`visual` rows, `table_json` must be present and well-formed, and the stem must NOT contain inline
data rows (reject a stem that looks like a data dump). It rejects and reports any row that breaks
the limits.

## Capacity & ops (must handle 120 concurrent)

- ~10 RPC/s steady (120 ÷ 12 s), with a burst of 120 at each round's `start_round`. Keep functions
  cheap and indexed; the sitting is ~75 min and load is sustained, not peaky.
- Preload the **next** round's art during the between-rounds break, not all nine up front
  (~3 MB × 9 ≈ 27 MB per player over the event, from Cloudflare).
- **Sign-in rate limit is the known risk:** Supabase allows 30 sign-ins per 5 min per IP, and a
  lab shares one campus IP. Document that the per-IP auth rate limit must be raised in the Supabase
  dashboard before a live sitting; support "sign in once beforehand" (sessions persist).
- Realtime stays under 200 concurrent connections; only host events use it.
- GitHub Actions: a daily keep-alive ping (free projects pause after 1 week idle) and a nightly
  `pg_dump` backup to a private repo (free tier has no backups).
- A `k6` load-test script simulating 120–150 players through a full round on a staging project.

## Deliverables & milestones

- **M1** — repo scaffold; Supabase migrations + RLS + all RPCs; seed 2 rounds of sample questions;
  unit tests for `assert_live`, scoring, and the no-key-leak guarantee (a test asserting served
  payloads contain no `is_correct`/`explanation`).
- **M2** — auth + domain lock + lobby + player join + instructor console (open / go-live / end).
- **M3** — the sealed rapid-fire loop with the Phaser trail and all 8 card components; Round 1 fully
  themed; end-of-round debrief; the **round-to-round handoff** (`go_live(next)` → break → next
  round) with the cumulative leaderboard.
- **M4** — Rounds 3 and 5 with their signature mechanics; import script; analytics views + CSV.
- **M5** — Cloudflare Pages deploy; keep-alive + backup actions; k6 load test; README with the
  pre-lab checklist (raise auth rate limit, confirm project not paused, set `closes_at`).

## Definition of done (must all pass)

- [ ] A served question payload, inspected in the network tab, contains no correct-answer marker,
      no `explanation`, and no `misconception`.
- [ ] Any game RPC called when the session is not `live` or after `closes_at` fails at the database.
- [ ] Timing uses the server clock; a client that fakes its timer cannot gain points.
- [ ] One session plays all 9 rounds; seq resets per round; the cumulative leaderboard sums rounds.
- [ ] Every table-bearing card renders `table_json` as a real `<table>`; no card puts data rows
      in the stem text; the import validator rejects such rows.
- [ ] Sign-in is limited to the allowed domain both at the auth hook and inside RPCs.
- [ ] `npm run build`, `npm run lint`, and the test suite all pass; the k6 run holds at 120 players.
- [ ] README documents the pre-lab checklist and every env var.

Write tests as you go. Keep the answer-key-never-leaks invariant permanently covered by an
automated test. Prefer small, reviewable commits, one per milestone step.
