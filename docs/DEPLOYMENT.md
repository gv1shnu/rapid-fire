# Deployment guide

How to take **The Lost Schema** from this repository to a live URL a class can
use. The stack is a static frontend (Cloudflare Pages) talking to a hosted
Supabase project over its public RPCs; PostgreSQL is the source of truth and no
secret ever ships to the browser.

> **Scope check — read first.** At the current milestone the deployable UI is the
> public **waiting screen**, the **practice preview** (`/?preview=question`), and
> the **instructor control room** (`/instructor`). The student auth/lobby, the
> Phaser trail, the card renderers, the debrief and the analytics UI are **not
> built yet** (see the Roadmap in the README). You can therefore stand up and
> exercise the backend and the instructor console end to end, but you cannot run
> a full nine-round student sitting until those milestones land. Deploy now to
> validate infra, auth, and instructor flows; do not schedule a graded lab on it
> yet.

Deploy order matters because of a chicken-and-egg with URLs: create the backend,
register OAuth, deploy the frontend to learn its URL, then come back and paste
that URL into the OAuth allowlists.

---

## 0. Prerequisites

- A **Supabase** account and organization (free tier is fine).
- A **Google Cloud** account (for the OAuth client + consent screen).
- A **Cloudflare** account (for Pages).
- The repo pushed to GitHub (it is: `gv1shnu/rapid-fire`).
- Locally: **Node 22.12+**, npm, and the **Supabase CLI**
  (`npm i -g supabase` or `brew install supabase/tap/supabase`).
- **Reviewed question pools** for the rounds you intend to run. The seed in this
  repo is synthetic development fixtures and must **not** be used as classroom
  content.

Sanity-check the build locally before deploying anything:

```sh
npm ci
npm run verify   # format:check + lint + test + build
```

---

## 1. Backend — Supabase project

### 1.1 Create the project

1. Supabase dashboard → **New project**. Pick the region closest to campus
   (lower latency for 120 concurrent players), set a strong database password,
   and save it in a password manager.
2. When it finishes provisioning, open **Project Settings → API** and copy:
   - **Project URL** → this is `VITE_SUPABASE_URL`.
   - **Publishable / anon key** → this is `VITE_SUPABASE_PUBLISHABLE_KEY`.
   - **service_role key** → keep this secret. It is used only from trusted SQL
     tooling. **Never** put it in a `VITE_` variable or the frontend.

### 1.2 Apply the migrations

Link the CLI to the project and push the migrations in `supabase/migrations/`:

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` applies migrations only. **Do not** run `supabase db reset` against a
hosted project — it wipes data and reloads the development seed.

Verify the schema and that the browser role has no table access:

```sql
-- Should list rounds, questions, options, sessions, round_releases, etc.
select table_name from information_schema.tables where table_schema = 'public';
-- Should error with "permission denied" if you are not a privileged role.
```

### 1.3 Load reviewed content (not the dev seed)

The hosted project starts empty of questions. Insert your **reviewed** pools
through a trusted SQL connection (SQL Editor or `psql`), inserting each question
and its four options **in one transaction** — the deferred constraint trigger
requires exactly four options with exactly one correct per question. Use
`supabase/seed.sql` only as a structural reference, never as classroom content.

### 1.4 Provision access control (trusted SQL only)

Run these in the SQL Editor. Browser writes to these tables are blocked by
design.

```sql
-- Allowed sign-in domains (lowercase, exact).
insert into public.allowed_domains (domain) values
  ('rishihood.edu.in'),
  ('nst.rishihood.edu.in'),
  ('newtonschool.co');

-- Class roster: lowercase email + instructor-assigned section.
insert into public.roster (email, section) values
  ('student1@rishihood.edu.in', 'A'),
  ('student2@newtonschool.co',  'A');
-- …bulk-import the rest.
```

Instructors are an **email allowlist provisioned up front** — no prior sign-in
needed. Each listed host gains instructor access on their first Google sign-in;
everyone else on an allowed domain stays a player/student.

```sql
insert into public.instructor_emails (email) values
  ('satyaki.das@newtonschool.co'),
  ('vishnu.gandarapu@newtonschool.co'),
  ('archit.raj@newtonschool.co'),
  ('omkar.gokhale@newtonschool.co');
```

(`public.instructors` remains as a view the RPCs check by user id; it resolves
these emails to whoever has signed in.)

### 1.5 Configure Auth

In **Authentication → Providers**:

- Enable **Google** only. Paste the Google **Client ID** and **Client secret**
  from step 2. Leave the requested scopes at `openid email profile`.
- Disable **Email** signups (email/password is not used).

In **Authentication → Hooks**, enable **Before User Created** and point it at the
Postgres function `public.before_user_created`. This rejects any non-Google or
non-allowed-domain signup before an account is created; every RPC re-checks the
domain regardless.

In **Authentication → URL Configuration** (you will finish this in step 4 once
you know the Pages URL):

- **Site URL**: your production frontend origin.
- **Redirect URLs**: add the origin and `<origin>/instructor`.

In **Authentication → Rate Limits**: the free tier's default per-hour and per-IP
limits are low. A whole class behind one campus NAT looks like a single IP —
raise the sign-in / token limits well above the class size, and have students
sign in a few minutes before the sitting to spread the load.

### 1.6 Storage (for later milestones)

Round art/audio is planned to be served from Cloudflare Pages (not Supabase) to
protect egress. ER-diagram questions will use a **private** Storage bucket served
via short-lived signed URLs during a live session. Create these buckets only when
M3/M4 lands; nothing is required for the current deploy.

---

## 2. Google Cloud — OAuth client + consent screen

### 2.1 OAuth client

1. Google Cloud Console → create/select a project.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
3. **Authorized JavaScript origins**: your production frontend origin (add it in
   step 4 once known; you can also add `http://localhost:5173` for local dev).
4. **Authorized redirect URIs**: the Supabase auth callback —
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
5. Save the **Client ID** and **Client secret**; paste them into Supabase
   (step 1.5).

### 2.2 Consent screen (External)

Under **APIs & Services → OAuth consent screen**, choose **External** and fill in:

- **App name**: The Lost Schema. **User support email**: your course email.
- **App logo**: upload `public/brand-logo.png` (512×512; Google downscales).
- **App domain → Privacy policy URL**: `https://<origin>/privacy` (Cloudflare
  Pages strips `.html`, so `/privacy.html` 308-redirects here — use the clean
  path).
- **App domain → Terms of service URL**: `https://<origin>/terms`.
- **Authorized domains**: `rishihood.edu.in` **and** `newtonschool.co` (the two
  registrable domains; `nst.rishihood.edu.in` is covered by `rishihood.edu.in`).
  Each authorized domain must be verified for the Google Cloud project.
- **Scopes**: only `openid`, `.../auth/userinfo.email`,
  `.../auth/userinfo.profile`. No sensitive/restricted scopes → no Google
  verification review and no 100-test-user cap.
- **Publishing status**: move to **In production** so any allowed-domain user can
  sign in (in Testing, only listed test users can).

---

## 3. Frontend — Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**,
   select `gv1shnu/rapid-fire`, branch `main`.
2. Build settings:
   - **Framework preset**: none / Vite.
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Environment variables** (Production and Preview):
     - `VITE_SUPABASE_URL` = your project URL
     - `VITE_SUPABASE_PUBLISHABLE_KEY` = your publishable/anon key
     - `NODE_VERSION` = `22` (or newer) so the build matches local.
3. Deploy. Pages runs the build and publishes `dist/`.

The repo already ships `public/_redirects` with an SPA fallback
(`/*  /index.html  200`). Real files (`/`, `/privacy.html`, `/terms.html`,
`/favicon.svg`, hashed `/assets/*`) are served directly; only unknown paths like
`/instructor` fall through to the app shell, so the client-side route and the
OAuth `/instructor` redirect survive a full page load and refresh.

### 3.1 Custom domain (optional)

Pages → your project → **Custom domains** → add e.g. `lostschema.rishihood.edu.in`
and follow the CNAME instructions. If you use a custom domain, treat **it** as
"the origin" everywhere below.

---

## 4. Close the loop — paste the real URL into the allowlists

Once you know the final origin (the `*.pages.dev` URL or your custom domain):

1. **Supabase → Auth → URL Configuration**: set **Site URL** to the origin and
   add both the origin and `<origin>/instructor` to **Redirect URLs**.
2. **Google → Credentials → your OAuth client**: add the origin to **Authorized
   JavaScript origins** (the redirect URI stays the Supabase callback).
3. **Google → OAuth consent screen**: confirm the Privacy/Terms URLs use the
   final origin.

Allow a minute for Google/Supabase to propagate, then hard-refresh.

---

## 5. Post-deploy verification

Work through this before trusting the deployment:

- [ ] Home screen loads at the origin; favicon and title appear.
- [ ] `/privacy` and `/terms` load and render the brand (the `.html` forms
      308-redirect to these).
- [ ] `/?preview=question` runs the local timer, seals a choice, and retries.
- [ ] `/instructor` loads and, with env vars set, shows **Sign in with Google**
      (not the offline "setup preview" banner). An empty offline preview here
      means the `VITE_*` env vars did not reach the build.
- [ ] Sign-in with an **allowed-domain** Google account succeeds and returns to
      `/instructor`.
- [ ] Sign-in with a **non-allowed** account (e.g. a personal `gmail.com`) is
      rejected by the Before User Created hook.
- [ ] A signed-in **instructor** (email in `public.instructor_emails`) can open a session
      and configure/release a round; a signed-in **non-instructor** cannot
      (`host_only`).
- [ ] After a release ends, `round_report` is readable only by the owning
      instructor (verify via the console / an RPC call), and refused while the
      round is still live.
- [ ] Browser devtools **Network** tab shows served questions carry **no**
      `is_correct` / `explanation` / `correct_option` / `points`.

---

## 6. Operations (free tier realities)

- **Keep-alive.** Free Supabase projects pause after inactivity. Before a lab,
  confirm the project is awake; consider a scheduled ping (e.g. a GitHub Action
  cron hitting a lightweight endpoint) in the days around a sitting.
- **Backups.** Confirm backups exist and are restorable before any graded use.
- **Load test.** Rehearse at **120–150 concurrent players** (e.g. a k6 script
  driving `join_session` → `start_round` → `submit_answer` loops) against a
  staging project — never against live teaching data. This repo is not yet a
  capacity certification.
- **Rate limits.** Recheck the actual project's auth limits against the class
  size on the day; quoted free-tier numbers change.
- **One sitting window.** A session's `closes_at` must be within three hours; a
  release that would exceed it is refused. Set one window for the whole sitting.

---

## 7. Updates and rollback

- **Ship an update:** push to `main`. The pre-push hook runs `npm run verify`
  locally; Cloudflare Pages then rebuilds and redeploys automatically. Each push
  is an immutable Pages deployment.
- **Roll back the frontend:** Pages → **Deployments** → pick a previous good
  deployment → **Rollback**. This does not touch the database.
- **Database changes:** add a new timestamped migration in `supabase/migrations/`
  and `supabase db push`. Never edit an applied migration in place; never
  `db reset` a project with real data.

---

## 8. Security reminders

- The **service_role key** and the database password never leave trusted tooling.
  Only `VITE_SUPABASE_URL` and the **publishable** key belong in the frontend
  build, and both are public by design.
- RLS is on for every table and browser roles are granted only the listed RPCs;
  do not add table policies or grant internal helpers to `authenticated`.
- Access control lives in `allowed_domains`, `roster` and `instructor_emails`, all
  managed by trusted SQL — user-editable profile metadata is never an authority.
