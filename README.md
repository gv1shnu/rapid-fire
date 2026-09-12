# The Lost Schema

A timed SQL assessment for the Rishihood / NST DBMS lab. Instructors approve a question count and seconds per question, release a shared question set, and review each student's results after closure. Students join with a college Google account and get one resumable attempt per round.

Only `rishihood.edu.in` and `nst.rishihood.edu.in` are accepted. Google Spaces distribution is planned; the instructor currently copies the join URL manually.

## Objective and current behavior

- Each question has an independent, immutable server deadline. A refresh never restarts it.
- Everyone receives the same frozen question set, with individual question order and opaque option tokens.
- Correct answers, explanations and scores stay sealed until the release ends, including for early finishers.
- Wrong answers and timeouts earn zero points. Scores cannot become negative.
- Instructors can end a release early. Accepted answers are preserved; unanswered questions become timeouts.
- Scores, correct/wrong/timeout counts, mean answering times, accuracy, and strict half-time counts are stored per student and round.
- Closed results can be recovered after refresh. A completed run cannot be replayed.

## Technology stack

| Layer         | Technology / responsibility                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| Interface     | React 19, strict TypeScript, accessible HTML/CSS                                       |
| Build         | Vite; static `dist/` output                                                            |
| Identity      | Supabase Auth, Google `openid email profile`                                           |
| Backend       | PostgreSQL 17 / Supabase; server-authoritative RPCs                                    |
| Authorization | RLS, revoked table access, explicit session membership, instructor email allowlist     |
| Tests         | Vitest, React Testing Library, real migrations in PGlite, PostgreSQL concurrency suite |
| Quality       | ESLint, Prettier, TypeScript, GitHub Actions, local pre-push verification              |
| Hosting       | Static hosting; Cloudflare Pages headers and SPA fallback included                     |

## Setup

Use Node.js 22.12+ (CI uses Node 22) and npm.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Without Supabase environment values, `/instructor` is an explicit setup preview and `/?preview=question` is public practice. They do not record real scores.

For connected play:

1. Create a Supabase project and apply **all migrations in order**. Migration 008 is a protocol change; apply it between sittings and deploy the matching frontend together.
2. The migration provisions the two allowed domains. Enable Google Auth and the `before_user_created` hook. Configure exact production redirect URLs as described in [deployment](docs/DEPLOYMENT.md).
3. Insert approved instructor emails into `public.instructor_emails`. They must belong to one of the allowed domains. Students require no roster provisioning.
4. Import your private production question bank. `supabase/seed.sql` is a public, 174-question practice fixture, **not a secret assessment bank**. Never import it into a graded production sitting. Never run a destructive seed reset against existing results.
5. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` and your hosting build environment. Only a publishable or legacy anon key belongs in the browser; never a service-role key.

```sql
insert into public.instructor_emails (email)
values ('approved-instructor@rishihood.edu.in');
```

The example is a placeholder; use the actual approved instructor account.

## Usage and timing

Open `/instructor`, sign in, select a section, choose the question count and 1–120 seconds per question, review, then release. The UI calculates **nominal answering time = count × seconds** and shows the join URL.

That duration also defines the joining window. A student who starts within it keeps their individual question timers after the joining window closes. Each accepted answer immediately serves the next question. Unanswered questions advance from their original deadlines even while disconnected; reconnecting catches up instead of granting extra time.

The release ends automatically once admission closes and all started attempts are finished, or when the instructor ends it. The separate session cutoff (maximum three hours) is a hard termination boundary. Early termination can interrupt a question; it is not described as normal per-question expiry. Finalization is materialized on the next state/report call; server time checks apply even without an open instructor tab.

Students see a sealed receipt when finished. After closure they can review their saved answers and explanations. The instructor can configure the next round; previous settings are retained subject to the next pool's size.

See [release behavior](docs/INSTRUCTOR_RELEASES.md) and [metric definitions](docs/ROUND_METRICS.md).

## Architecture

```text
React browser
  ├─ Google OAuth → Supabase Auth → exact domain / verified provider checks
  └─ Supabase RPC
       ├─ instructor: open_session, configure_round, go_live, end_round,
       │              end_session, instructor_state, round_report
       ├─ student: join_session, student_state, start_round, next_question,
       │           submit_answer, submit_round, my_result
       └─ private helpers / tables (no direct browser access)
            sessions + session_members → round_releases
              → release_questions (frozen content and keys)
              → round_runs → attempts (opaque option tokens, immutable clocks)
```

Student operations lock the session before the student's run. Instructor closure locks the session before finalizing runs. Duplicate submissions cannot change an accepted answer or produce duplicate scores. The student controller serializes requests, retains uncertain submissions for identical retries, backs off failures, validates responses, and ignores responses after unmount/sign-out. It anchors visual time to server timestamps and `performance.now()`.

`src/question-catalogue.json` contains only public preview counts/titles, generated alongside the development seed. The browser never imports the seed or answer bank. Historical migrations are retained for upgrades; the old roster table is legacy data, not an access-control mechanism.

## Tests and push protection

```sh
npm run verify             # formatting, lint, tests, typecheck and production build
npm run test:watch
npm run hooks:install       # also installed by ordinary npm ci/install
```

The database suite executes actual migrations and seed SQL, covering authorization, sealed payloads, session membership, immutable submissions, timing, scoring, snapshots and recoverable results. Student component tests cover clocks, network failures, lifecycle changes and malformed responses.

For real transaction/concurrency tests, use a **disposable PostgreSQL 17 database whose name ends in `_test`**. The suite recreates its public/auth/realtime schemas. Never point this at Supabase or production.

```sh
POSTGRES_TEST_URL=postgresql://localhost/rapid_fire_test npm run verify
```

CI provisions that database and runs concurrent starts for 120 students, duplicate submissions, and instructor closure racing submissions. This verifies transaction behavior, not hosted Supabase capacity or campus network latency.

GitHub Actions checks the pushed revision. Configure branch protection to require the `verify` check and disallow bypasses. A local hook alone cannot prevent erroneous pushes. Hosting should deploy only revisions whose required checks pass.

## Production release

Favicons, the web manifest, public privacy/terms pages, SPA fallback and security headers are included. Complete the approved contact address and actual public origin before publishing. Do not confuse allowed **email domains** with Google's authorized **web domains**.

```sh
PUBLIC_APP_URL=https://your-real-origin \
SUPPORT_EMAIL=your-monitored-address \
PRODUCTION_QUESTION_BANK_CONFIRMED=yes \
npm run release:check
```

Also set the two public Supabase variables. This explicit check fails if legal contact placeholders remain or the deployment settings are missing. [Deployment instructions](docs/DEPLOYMENT.md) cover OAuth, migrations, headers, staging acceptance and operational limits.

## Future additions

- Google Spaces link distribution after instructor approval.
- Instructor analytics interface and CSV export over the existing report RPC.
- Round-specific stories, visual themes, and the expedition trail.
- Realtime notifications to replace periodic status polling.
- Deployment-specific monitoring, campus load rehearsals and retention automation.

The original product plan is preserved in [docs/PROMPT.md](docs/PROMPT.md). Current timing and security behavior above supersedes its earlier fixed/shared timing assumptions.
