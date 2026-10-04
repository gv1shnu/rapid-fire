-- Open sign-in to ANY Google account (owner decision, 2026-10-04).
--
-- Previously only the allowed_domains entries could sign in or call an RPC. Both
-- gates change together: before_user_created admits the account and assert_domain()
-- guards every RPC, so relaxing only one would let people sign in and then fail.
-- Both still require a confirmed email from the Google provider. The error code
-- stays 'domain_not_allowed' because the frontend matches it.
--
-- REQUIRES on the Google side: the OAuth app audience must be External and published,
-- or Google blocks outside accounts before this hook ever runs.

create or replace function public.assert_domain() returns uuid language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
 select * into u from auth.users where id=auth.uid();
 if u.id is null or u.email_confirmed_at is null or u.raw_app_meta_data->>'provider' is distinct from 'google'
 then raise exception 'domain_not_allowed'; end if;
 return u.id;
end $$;

create or replace function public.before_user_created(event jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
 if event->'user'->'app_metadata'->>'provider' is distinct from 'google'
 or coalesce(event->'user'->>'email','') !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
 return jsonb_build_object('error',jsonb_build_object('http_code',403,'message','Sign in with a Google account.'));
 end if;
 return '{}'::jsonb;
end $$;

-- The table is retained for data compatibility but no longer consulted.
delete from public.allowed_domains;
