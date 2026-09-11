# The Lost Schema

A sealed, rapid-fire SQL treasure hunt for a university DBMS lab. Nine themed
rounds, an instructor-controlled clock, and a strict rule that **no score, no
correct answer and no explanation ever reaches the browser until a round's
debrief**. Built to run ~120 students concurrently on free tiers within a
75-minute sitting.



---

## Objective

Give a DBMS class a fair, fun, cheat-resistant way to drill SQL and relational
concepts under time pressure:

- **Fairness by construction.** Every student in a section shares one countdown
  and gets exactly one attempt per round. Reconnecting, refreshing, editing the
  browser clock, or opening a second tab never buys more time or a second draw.
- **Sealed play.** The server serves only the current question and its options —
  never the answer key, the scoring, or another student's data. Results are
  revealed in a single end-of-round debrief.
- **Instructor control.** The instructor picks the question pool, the count and
  the per-question timer, reviews, and releases. They can end a round early and
  read per-student / per-question analytics after it closes.

## Current status

Implemented so far:

- Strict TypeScript + Vite + React scaffold; Phaser 4 dependency wired for the
  playable milestone.
- Complete Supabase/PostgreSQL foundation: schema, row-level security, the
  Google-domain sign-up hook, trusted roster + instructor authorization, all
  game and host RPCs, server-side timing and scoring, cumulative placement, and
  configurable per-round releases with analytics.
- A public **waiting screen**, a **one-question practice preview**
  (`/?preview=question`, local timer, sealed choice, no scoring), and the
  **instructor control room** (`/instructor`) with pool counts, configurable
  count/timer, review + approval, a shared countdown and early closure.
- An elaborate automated test suite (database + React components) and a
  pre-push validation hook.

Pending (see [Roadmap](#roadmap)): student auth/lobby, the Phaser trail and card
renderers, the debrief UI, realtime broadcast delivery, the reviewed authoring
pipeline, analytics UI/CSV, and deployment + load testing.

## Tech stack

| Layer              | Choice                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **Language**       | TypeScript (strict), PL/pgSQL                                                                         |
| **Build / dev**    | Vite 8                                                                                                |
| **UI**             | React 19                                                                                              |
| **2D map / trail** | Phaser 4 (mounted in React; playable milestone)                                                       |
| **Backend**        | Supabase — PostgreSQL 17 as the source of truth; game logic in `SECURITY DEFINER` functions via `rpc` |
| **Auth**           | Supabase Auth, Google provider only, scopes `openid email profile`, domain-locked                     |
| **Realtime**       | Supabase Realtime Broadcast for host events only, with a 3-second polling fallback                    |
| **Tests**          | Vitest, PGlite (embedded Postgres), Testing Library + jsdom                                           |
| **Quality gates**  | ESLint, Prettier, `tsc`, and a git pre-push hook                                                      |
| **Hosting (plan)** | Cloudflare Pages (static); round art/audio from Pages to protect Supabase egress                      |

## Setup and usage

Requires **Node 22.12+** (tested on Node 25.9) and npm.

```sh
npm ci          # install; also points git at the .githooks pre-push hook
npm run verify  # format:check + lint + test + build (what the pre-push hook runs)
npm run dev     # http://127.0.0.1:5173
```

Individual scripts:

```sh
npm test            # Vitest: database suite (PGlite) + React component suites
npm run test:watch  # watch mode
npm run build       # tsc -b && vite build
npm run lint        # ESLint
npm run format      # Prettier write
```

`npm test` runs the real migrations and seed inside **PGlite**, an embedded
PostgreSQL engine — no Docker and no Supabase credentials needed. Only the
Supabase-owned `auth.users`, `auth.uid()` and `realtime.send()` interfaces are
stubbed; game logic, grants, RLS, constraints and scoring execute in real
PostgreSQL.

For the full local Supabase stack, install Docker and the Supabase CLI:

```sh
supabase start
supabase db reset   # destroys the LOCAL dev DB and reloads the seed — never run against teaching data
```

### Environment

Copy `.env.example` to `.env.local` for the instructor's Supabase connection:

| Variable                        | Purpose                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `VITE_SUPABASE_URL`             | Public project API URL; local default is `http://127.0.0.1:54321`.                   |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Supabase publishable key. Never put a service-role key in a `VITE_` variable. |

When both are present the instructor page connects for real; otherwise it runs
as a clearly labelled offline setup preview. Nothing secret is needed for tests.

### Provisioning (trusted SQL connection only — never browser writes)

1. **Allowed domains.** Insert the college domains into `public.allowed_domains`:

   ```sql
   insert into public.allowed_domains (domain) values
     ('example.edu'),
     ('students.example.edu'),
     ('partner.example');
   ```

2. **Roster.** Import lowercase student/staff emails and their sections into
   `public.roster (email, section)`.
3. **Instructors.** After an instructor's Google account exists in
   `auth.users`, insert its UUID into `public.instructors`.
4. **Google OAuth.** Enable only the Google provider with `openid email profile`;
   keep email signup disabled. Store the client ID/secret in Supabase provider
   settings, never in the frontend. Add the deployed origin's `/instructor` path
   to the OAuth redirect allowlist.
5. **Sign-up hook.** Enable `public.before_user_created` as the **Before User
   Created** hook in hosted Supabase (local config is in
   `supabase/config.toml`).

The hook requires an exact allowed domain **and** Google provider metadata.
Every RPC re-checks the verified user's provider and domain against
`auth.users`; section membership comes from the administrator-managed roster —
user-editable profile metadata is never an authority.

### Google OAuth consent screen (External)

When registering the OAuth app as **External**, Google asks for an app
logo, a privacy policy URL and a terms-of-service URL. This repo ships all
three as static assets served from the site root:

| Asset            | Served at         | Source                                         |
| ---------------- | ----------------- | ---------------------------------------------- |
| Privacy Policy   | `/privacy.html`   | [public/privacy.html](public/privacy.html)     |
| Terms of Service | `/terms.html`     | [public/terms.html](public/terms.html)         |
| App logo (120px) | upload in console | [public/brand-logo.png](public/brand-logo.png) |

Set the app's **Authorized domains** to `example.edu` and
`partner.example` (these are the registrable domains; `students.example.edu` is
covered by `example.edu`). Both legal pages already name
`example.edu`, `students.example.edu` and `partner.example` as the only
accepted sign-in domains; edit the contact line in each page before publishing.

## Architecture

```
Browser (React + Vite, no secrets)
  │  supabase.rpc(...)           Google sign-in (openid email profile)
  ▼
Supabase Auth ──► before_user_created hook  (Google + allowed domain only)
  │
  ▼
PostgreSQL (source of truth)
  ├─ Tables: allowed_domains, roster, instructors, rounds, questions, options,
  │          players, sessions, round_releases, round_runs, attempts
  ├─ RLS on every table; browser roles have NO direct table access
  └─ SECURITY DEFINER functions (the only granted surface):
       student:   join_session, start_round, next_question, submit_answer, submit_round
       instructor: open_session, configure_round, go_live, end_round, end_session,
                   instructor_state, round_report
       internal (not granted): assert_domain, assert_live, assert_release,
                   serve_pending, lock_round, score_run, finish_release, validate_mcq
```

Key design decisions:

- **No answer keys in the client.** Serving functions build an explicit payload
  allowlist (option id + display body only). A recursive test asserts that no
  served payload ever contains `is_correct`, `explanation`, `misconception`,
  `correct_option`, `points`, `score` or `streak`.
- **Server owns the clock.** A question's timer starts on its first real serve
  (`served_at`), not up front. `clock_timestamp()` measures true server time.
  Answers past the approved seconds + 1s grace become NULL timeouts; the shared
  release deadline overrides per-question grace.
- **One attempt, idempotent.** `(session_id, player_id, round_id)` identifies a
  run; a transaction lock plus a persisted `debrief` make retries return the
  same result. Ending a release is permanent and cannot reopen.
- **Configurable releases.** Each round freezes its own `question_count` and
  `seconds_per_question` at release; scoring, metrics, accuracy and the
  half-time threshold all scale to those approved settings.
- **Deferred constraint triggers** enforce exactly four options with exactly one
  correct answer, so authors insert a question and its options in one
  transaction.

See [docs/INSTRUCTOR_RELEASES.md](docs/INSTRUCTOR_RELEASES.md) and
[docs/ROUND_METRICS.md](docs/ROUND_METRICS.md) for the release lifecycle and
metric definitions.

### Database API

| RPC                                                 | Behavior                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `join_session(code, nickname, avatar_seed)`         | Joins a lobby/live session within its closing time; verifies the roster section. Returns session metadata only.            |
| `start_round(p_session, p_round)`                   | Creates one immutable draw of the approved size. Returns question 1, or the pending question on retry.                     |
| `next_question(p_session, p_round)`                 | Resumes the pending question without changing its timer.                                                                   |
| `submit_answer(p_session, p_round, seq, option_id)` | Records an answer or timeout and returns only the next question. Pass NULL for a timeout after the approved question time. |
| `submit_round(p_session, p_round)`                  | Requires the approved count of answers/timeouts. Scores and returns the one debrief with cumulative points and placement.  |
| `open_session(p_section, p_closes_at)`              | Allowlisted instructors only. Creates a six-letter lobby code; closing time must be within three hours.                    |
| `configure_round(p_session, p_round, count, secs)`  | Assigned instructor. Saves a draft release (count 1–pool, seconds 1–120) before go-live.                                   |
| `go_live(p_session, p_round)`                       | Assigned instructor. Freezes settings, starts the shared countdown, advances exactly one round in order.                   |
| `end_round(p_session, p_round)`                     | Assigned instructor. Ends a release early; remaining questions become forced-timeout zeros.                                |
| `end_session(p_session)`                            | Assigned instructor. Finalizes and closes the sitting.                                                                     |
| `instructor_state(p_session)`                       | Assigned instructor. Pool counts, sections, current release + countdown; also finalizes expired runs.                      |
| `round_report(p_session, p_round)`                  | Assigned instructor, after the round closes. Per-student, per-question and class summaries.                                |

Host functions emit private `session_opened`, `round_started` and
`session_ended` Broadcast events to `session:<uuid>`. No answer events are ever
emitted.

## Testing

The suite is designed so that a red test blocks a push (`npm run verify` is what
the [pre-push hook](.githooks/pre-push) runs).

- **Database suite** (`tests/database.test.ts`, Node + PGlite): draw
  composition, unseen clocks, immutable retries, a recursive no-key-leak
  assertion over every served payload, early-submission and invalid-option
  attacks, server timeouts, closed/lobby/expired/ended gates, domain and section
  restrictions, direct-table and internal-helper denial, the sign-up hook,
  host-only authorization and ordering, full-round scoring with streak
  thresholds and reset, round handoff, configurable releases above 30 questions,
  scaled scoring/metrics/half-time, partial-run finalization, and the
  four-options-one-correct constraint.
- **React component suites** (jsdom + Testing Library): App route selection;
  the practice preview's sealed phases, timeout and retry with fake timers; the
  instructor control room's validation, duration math, disabled empty pools,
  approval → live countdown, confirmed early end, next-round handoff, and
  session-storage persistence; and the public preview catalogue's shape and
  absence of any answer-key fields.

## Roadmap

Following the milestone plan in the build spec:

- **M2 — Auth & lobby.** Google sign-in, domain lock end to end, player join and
  section lobby, and instructor open/go-live/end against hosted Supabase.
- **M3 — Sealed rapid-fire loop.** The Phaser 30-tile trail, all eight card
  renderers, Round 1 fully themed, the end-of-round debrief UI, the
  round-to-round handoff, and the cumulative between-round leaderboard.
- **M4 — Signature rounds & authoring.** Rounds 3 and 5 with their mechanics, the
  reviewed CSV/Sheet import pipeline (Shiki highlighting and diagram SVGs at
  import time), and the analytics views + CSV export UI.
- **M5 — Deploy & ops.** Cloudflare Pages deploy, keep-alive + backup automation,
  a k6 load test at 120–150 players, private signed-URL diagram delivery, and
  the realtime + polling fallback verified under load.

### Pre-lab checklist (deployment milestone)

- Confirm the Supabase project is awake and backups are restorable.
- Verify and raise auth per-IP limits for the shared campus IP; have students
  sign in beforehand.
- Confirm Google-only auth, the domain hook, roster sections and the instructor
  allowlist.
- Replace development fixtures with reviewed pools for all nine rounds.
- Set one `closes_at` for the whole sitting and rehearse round handoffs.
- Verify question clearing on closure, private diagram expiry, realtime and the
  polling fallback.
- Run the load test at 120–150 players; this repo is not yet a capacity
  certification.

## Sample content

`supabase/seed.sql` contains all nine round themes and 45 development fixtures
each for rounds 1 and 2 (15 easy, 20 medium, 10 hard). They deliberately repeat
15 concepts with synthetic difficulty labels to exercise pool selection and are
**not reviewed classroom content**. Regenerate with
`node scripts/generate-seed.mjs`.

## Further reading

- [Supabase function security guidance](https://supabase.com/docs/guides/database/functions)
- [Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)
