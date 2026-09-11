-- Students self-register and join a session by its code; their section is the
-- session's section (sections are a release attribute now, not a roster fact).
-- Any allowed-domain, Google-authenticated student may join. Membership for the
-- rest of the round loop is "you are a player in this session's section".

create or replace function public.assert_live(p_session uuid) returns public.sessions language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for share;
 if s.id is null or s.status<>'live' or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if not exists(select 1 from public.players p where p.id=uid and p.section=s.section) then raise exception 'not_in_this_section'; end if;
 return s;
end $$;

create or replace function public.join_session(code text,nickname text,avatar_seed text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where sessions.code=upper(trim(join_session.code)) for share;
 if s.id is null or s.status not in ('lobby','live') or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 insert into public.players values(uid,s.section,trim(nickname),avatar_seed) on conflict(id) do update set nickname=excluded.nickname,avatar_seed=excluded.avatar_seed,section=excluded.section;
 return jsonb_build_object('session_id',s.id,'status',s.status,'current_round',s.current_round,'closes_at',s.closes_at);
end $$;
