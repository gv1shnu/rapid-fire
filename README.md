# The Lost Schema

A sealed SQL treasure hunt for a university DBMS lab: nine rounds with instructor-selected question counts and timers (defaults: 30 questions and 12 seconds). The complete build specification is in [docs/PROMPT.md](docs/PROMPT.md).

## Status: database foundation and instructor release controls

Implemented: strict TypeScript + Vite + React scaffold, Phaser 4.2 dependency, Supabase migrations, RLS, domain hook, trusted roster and instructor authorization, all specified game/host RPCs, server timing, scoring, cumulative placement, two development question pools, and PostgreSQL integration tests. The browser shows a waiting screen and a one-question practice preview at `/?preview=question`. The preview has a local 12-second timer, sealed choice selection and a retry button; it does not connect to a live game or score answers.

The instructor setup interface now lives at `/instructor`: pool counts, configurable questions and timers, review/approval, shared countdown and early closure. It runs as an explicitly labeled preview without credentials, or uses Google sign-in and the protected RPCs when Supabase is configured. See [instructor release behavior](docs/INSTRUCTOR_RELEASES.md). Student auth/lobby, Phaser, full card renderers, debrief UI, broadcasts and question clearing, reviewed imports, analytics UI/CSV, deployment and load testing remain pending.

## Run locally

Requires Node 22.12+ (or a supported newer version) and npm. Tested here with Node 25.9.

```sh
npm ci
npm test
npm run build
npm run lint
npm run format:check
npm run dev
```

Open <http://127.0.0.1:5173>. `npm test` executes the actual migration and seed in PGlite, an embedded PostgreSQL engine. It needs neither Docker nor Supabase credentials. Only the Supabase-owned `auth.users`, `auth.uid()` and `realtime.send()` interfaces are test stubs; game logic, grants, RLS, constraints and scoring execute in PostgreSQL.

For the complete local Supabase stack, install Docker and the Supabase CLI:

```sh
supabase start
supabase db reset
```

`db reset` destroys the **local development** database and reloads the seed. Do not use it against teaching data. Hosted Supabase/PostgREST, OAuth, actual Broadcast delivery and multi-connection load have not yet been verified. No hosted project is provisioned by this milestone.

## Environment and provisioning

Copy `.env.example` to `.env.local` for the instructor's Supabase connection:

| Variable                        | Purpose                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `VITE_SUPABASE_URL`             | Public project API URL; local default is `http://127.0.0.1:54321`.                   |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Supabase publishable key. Never put a service-role key in a `VITE_` variable. |

The instructor page consumes these public values when both are present. Otherwise it shows a local setup preview. Nothing secret is required to run tests.

Configure the following using a trusted SQL connection, never browser writes:

1. Insert the actual lowercase college domain(s) into `public.allowed_domains`. No real domain is assumed or seeded.
2. Import lowercase email addresses and instructor-assigned sections into `public.roster`.
3. After an instructor's Google account exists in `auth.users`, insert its UUID into `public.instructors`.
4. Enable only Google OAuth with `openid email profile`; keep email signup disabled. Store the Google client ID and secret in Supabase provider settings, not the frontend.
5. Enable `public.before_user_created` as the **Before User Created** hook in hosted Supabase. Local hook configuration is included in `supabase/config.toml`.

The hook requires an exact allowed domain and Google provider metadata. Every RPC rechecks the verified user's provider and domain against `auth.users`. Section checks use the administrator-managed roster; user-editable profile metadata is never an authority.

## Student and round analytics

Submitted rounds now log right/wrong/timeout counts, nonnegative scores, average response time, accuracy, and selections made in under half of the approved question time. The instructor-only `round_report` RPC returns student, class and per-question summaries after the selected rapid fire closes. See [metric definitions and report fields](docs/ROUND_METRICS.md). The report UI and CSV export are still pending.

## Database API

| RPC                                                 | Behavior                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join_session(code, nickname, avatar_seed)`         | Joins a lobby/live session within its closing time; verifies the roster section. Returns session metadata only.                                               |
| `start_round(p_session, p_round)`                   | Creates one immutable draw of the approved size. Returns question 1, or the current pending question on retry.                                                |
| `next_question(p_session, p_round)`                 | Resumes the pending question without changing its timer.                                                                                                      |
| `submit_answer(p_session, p_round, seq, option_id)` | Records the answer or timeout and returns only the next question. Pass NULL for a timeout once the approved question time has elapsed.                        |
| `submit_round(p_session, p_round)`                  | Requires the approved count of answers/timeouts. Scores and returns the only debrief, with cumulative points and placement. Retries return its stored result. |
| `open_session(p_section, p_closes_at)`              | Allowlisted instructors only. Creates a six-letter lobby code; closing time must be within three hours.                                                       |
| `go_live(p_session, p_round)`                       | Assigned instructor only. Advances exactly one round; refuses while an existing current-round attempt remains unsubmitted.                                    |
| `end_session(p_session)`                            | Assigned instructor only. Closes immediately.                                                                                                                 |

Host functions emit private `session_opened`, `round_started`, and `session_ended` Broadcast events to `session:<uuid>`. Subscription authorization and client polling are pending with the connected UI. No answer events are emitted.

## Security and timing decisions

- All application tables have RLS and deny direct browser access. Internal helpers, including `assert_live`, are not callable by browser roles. Only the listed RPCs are granted to `authenticated`; the auth hook is granted only to `supabase_auth_admin`.
- Definer functions fix their search path to `public`, qualify table names and revoke public schema creation privileges. They select an explicit public payload; no full question/option row is serialized.
- `round_runs` provides a transaction lock and persisted debrief for idempotency. Concurrent tabs serialize on the same run. Session row locks coordinate host closure with active calls.
- Unseen `attempts.served_at` values are NULL. A question's server timer starts only on its first actual serve. This intentionally corrects the spec's initial all-rows timestamp, which would expire later questions before students see them.
- `clock_timestamp()` measures actual server time, including lock waits. Answers received after the approved question time plus one second become NULL timeouts. Grace-period correct answers earn base points with no speed bonus. Timeout calls before the approved time are refused. The shared release deadline takes precedence over question grace.
- Approved per-round settings supersede the original fixed count and timer. Streak multipliers apply on the third and sixth consecutive correct answers. Tiebreak time sums actual server-measured answer durations, including late submissions.
- Early debriefs are refused. Normal submissions require the approved number of answered/timed-out questions. Instructor closure or automatic expiry finalizes partial runs with forced timeouts and permanently blocks further answers.
- Cumulative placement at submission is a snapshot. The between-round live leaderboard is M3 work.
- Deferred constraint triggers enforce **exactly four options and one correct**, beyond the partial unique index's at-most-one guarantee. Author edits must insert questions and their options in one transaction. Keep question content immutable during a live sitting.

See Supabase's [function security guidance](https://supabase.com/docs/guides/database/functions) and [Before User Created hook documentation](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook).

## Sample content and tests

`supabase/seed.sql` contains all nine round themes and 45 development fixtures each for rounds 1 and 2 (15 easy, 20 medium, 10 hard). These deliberately repeat 15 concepts with synthetic difficulty labels to exercise pool selection; they are **not reviewed classroom content**. Regenerate with `node scripts/generate-seed.mjs`. Only concept cards are seeded in M1; mixed display types belong to the playable round milestone.

The tests cover draw composition, unseen clocks, immutable retries, recursive no-key-leak assertions over served payloads, early submission attacks, server timeouts, closed/lobby/expired gates, domain/section restrictions, direct-access denial, hook restrictions, host authorization, full-round scoring, streak thresholds/reset, and round handoff.

## Pre-lab checklist (deployment milestone)

- Confirm the Supabase project is awake and backups are restorable.
- Verify the current auth per-IP limits in the dashboard and raise them sufficiently for the shared campus IP; have students sign in beforehand. The spec's quoted free-tier limits must be rechecked against the actual project before a sitting.
- Confirm Google-only auth, the domain hook, roster sections and instructor allowlist.
- Replace development fixtures with reviewed pools for all nine rounds.
- Set one `closes_at` for the whole sitting and rehearse instructor round handoffs.
- Verify question clearing on closure, private diagram expiry, realtime and the polling fallback.
- Run the M5 staging load test at 120–150 players. M1 is not a capacity certification.
- Confirm Cloudflare art delivery, private nightly backups and keep-alive automation before teaching.
