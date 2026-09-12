# Production deployment

## Required deployment values

Record the actual public HTTPS origin, a monitored support/privacy email, the Supabase project URL/public key, approved instructor emails, and the private production question-bank owner. These values are deployment-specific. Do not submit OAuth branding or publish legal contact placeholders.

The application accepts only `rishihood.edu.in` and `nst.rishihood.edu.in`. Migration 008 removes other entries from `allowed_domains`; take this into account when upgrading an existing installation.

## Supabase

1. Use a dedicated production project, separate from development.
2. Back up existing data. End all live sittings before applying migrations. Review `supabase db push --dry-run` against the intended linked project, then apply migrations in filename order. Do not use database reset or seed replacement on production.
3. Enable Google as the identity provider and enable the `public.before_user_created` auth hook. Every RPC independently rechecks verified email, Google provider and exact domain membership.
4. Add actual approved college emails to `instructor_emails`. No roster is required. A matching section does not grant membership in a session.
5. Import private, reviewed assessment questions. The repository's public seed is practice content and must not be used as a secret graded bank. Each question requires four options and exactly one correct answer. Content is frozen at release; later bank edits cannot affect that release.
6. Set the Auth site URL to your actual origin. Add exact frontend return URLs for `/`, `/?j=*` (only the query variation), and `/instructor` using Supabase's supported redirect patterns. Keep production origins restricted; avoid broad cross-domain wildcards.
7. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the frontend build environment. Never expose a service-role key. A custom Supabase API domain also requires updating `public/_headers` connect-src.

The local Supabase CLI configuration is for development. Hosted provider credentials, hook enablement, redirect allowlists and regional settings must be configured in the actual project.

## Google External OAuth branding

Use the real app name, monitored support address, homepage, privacy URL and terms URL. Privacy and terms must be publicly accessible without signing in, and linked from the homepage. The included icon-512.png can be used as the branding logo.

Google's **authorized domains describe your web origins and redirect infrastructure**, not the email domains of permitted students. Configure the actual deployed domains and the Supabase callback shown in its dashboard, and complete applicable ownership verification. Do not add a domain merely because users have email addresses there.

Use a Web OAuth client with the exact Supabase Auth callback URI. Request only `openid email profile`. Test with accounts from both approved domains and verify rejection of `newtonschool.co` and lookalike suffixes. Moving Google branding to External/production does not replace the application's database domain checks.

Primary references: [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies) and [brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

## Static hosting and quality gates

Build with Node 22.12+ and publish `dist/`. Cloudflare Pages consumes the supplied `_headers` and `_redirects`; equivalent headers and SPA rewrites must be configured on another host. Real privacy/terms/icon files must remain publicly accessible. Cloudflare may canonicalize `.html` pages to extensionless URLs; use the final reachable URLs on the consent screen.

Require GitHub's `verify` check on the protected main branch, including administrators where available. Preserve any stricter existing protection. Disable direct deployment of revisions whose required checks have not passed. The local pre-push hook is only an additional check.

Run `npm run release:check` with `PUBLIC_APP_URL`, `SUPPORT_EMAIL`, both Supabase frontend values and `PRODUCTION_QUESTION_BANK_CONFIRMED=yes`. This fails while contact placeholders remain. It validates configuration presence, not Google approval or actual deployment connectivity.

## Staging acceptance before a graded sitting

- Run `npm run verify` with a disposable PostgreSQL 17 `POSTGRES_TEST_URL`. CI runs this transaction suite automatically.
- Use actual Google sign-in on the deployed origin; check both student domains, disallowed domains, instructor access and exact redirects.
- Rehearse with two real student accounts: same frozen question set, separate option tokens, sealed early completion, refresh/resume, instructor end and recovered debrief.
- Test a slow connection, a disconnect past several question deadlines, duplicate tabs and an instructor ending while submissions are in flight.
- Confirm privacy/terms links, all icon files, SPA deep links and response security headers on the deployed host.
- Rehearse the target class size on the actual Supabase tier and campus network. The local 120-student transaction test does not measure hosted PostgREST, Auth, free-tier quotas or network latency. Monitor errors and database utilization during the rehearsal.

## Operations and recovery

A question's timer never resets. The joining window closes new attempts; existing attempts keep their question clocks until completion, manual end or the session hard cutoff. A missed response is retried with the same option token. Manual end is permanent for that release.

If the frontend deployment fails, roll back the frontend only to a revision compatible with the current RPC protocol. Migration 008 removes the numeric answer API, so a pre-008 frontend is not a compatible rollback. Prefer a forward fix while keeping the affected sitting closed.

Use Supabase backups and limit administrative credentials. Handle retention/deletion requests through the teaching team's documented process; retention automation is not implemented. Do not promise automatic term-end deletion until it exists. Historical migrations and the legacy roster table are retained for data compatibility, but authorization uses explicit session membership.
