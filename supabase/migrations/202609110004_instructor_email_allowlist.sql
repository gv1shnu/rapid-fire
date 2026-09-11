-- Instructor access is an email allowlist provisioned *before* anyone signs in,
-- so the named hosts have instructor access on their first Google sign-in with
-- no per-user post-signup step. Everyone else on an allowed domain stays a
-- player/student.
--
-- The game/host RPCs check instructor membership against `public.instructors`
-- keyed by user id. We keep that contract: `instructors` becomes a view that
-- maps the email allowlist onto whoever has signed in, so no RPC changes.

drop table if exists public.instructors; -- was uuid-keyed and required a prior signup

create table public.instructor_emails (
  email text primary key check (email = lower(email))
);
alter table public.instructor_emails enable row level security;
revoke all on public.instructor_emails from public, anon, authenticated;

create view public.instructors as
  select u.id
  from auth.users u
  join public.instructor_emails e on e.email = lower(u.email);
revoke all on public.instructors from public, anon, authenticated;
