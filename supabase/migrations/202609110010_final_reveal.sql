-- Solutions and standings belong to the final page. Two rules change here:
--  1. A round's debrief (the solutions) stays sealed for every student until the
--     whole rapid fire is over -- the session timer has run out or the host ended
--     it -- not merely when that one round's release ended.
--  2. The leaderboard names people by their real Google profile name rather than
--     the joined nickname.

-- Sealed until the session itself is over, then any submitted round unlocks.
create or replace function public.my_result(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r public.round_runs; s public.sessions;
begin
 s:=public.assert_member(p_session);
 if s.status<>'closed' and (s.closes_at is null or clock_timestamp()<s.closes_at) then
  raise exception 'debrief_not_released';
 end if;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid();
 if r.submitted_at is null then raise exception 'result_unavailable'; end if;
 return r.debrief;
end $$;

-- Reviewable rounds appear only once the whole rapid fire has ended, so no
-- solutions leak between rounds while play is still live.
create or replace function public.student_state(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cfg public.round_releases; r public.round_runs;
begin
 -- This synchronization RPC deliberately takes the session lock before player locks.
 perform public.assert_domain();
 if not exists(select 1 from public.session_members where session_id=p_session and player_id=auth.uid()) then raise exception 'not_session_member'; end if;
 perform public.finish_release(p_session,(select current_round from public.sessions where id=p_session));
 s:=public.assert_member(p_session);
 select * into cfg from public.round_releases where session_id=p_session and round_id=s.current_round;
 select * into r from public.round_runs where session_id=p_session and round_id=s.current_round and player_id=auth.uid();
 return jsonb_build_object('session_id',s.id,'status',case when clock_timestamp()>=s.closes_at then 'closed' else s.status end,'current_round',s.current_round,
 'release_status',cfg.status,'can_start',cfg.status='live' and (r.session_id is not null or clock_timestamp()<cfg.admission_closes_at),
 'submitted',r.submitted_at is not null,'server_now',clock_timestamp(),
 'results',(select coalesce(jsonb_agg(rr.round_id order by rr.round_id),'[]'::jsonb) from public.round_runs rr
   where rr.session_id=p_session and rr.player_id=auth.uid() and rr.submitted_at is not null
     and (s.status='closed' or clock_timestamp()>=s.closes_at)));
end $$;

-- Final standings, revealed to members once the session is over, naming each
-- player by their real Google profile name (falling back to the nickname).
create or replace function public.session_leaderboard(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 s:=public.assert_member(p_session);
 if s.status<>'closed' and (s.closes_at is null or clock_timestamp()<s.closes_at) then
  raise exception 'leaderboard_not_released';
 end if;
 return coalesce((
  select jsonb_agg(board order by board.rank, lower(board.name))
  from (
   select (select coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),
                           nullif(trim(u.raw_user_meta_data->>'name'),''),
                           p.nickname)
           from auth.users u where u.id=p.id) name,
     sum(rr.total_points)::int points,
     rank() over(order by sum(rr.total_points) desc, sum(rr.total_time)) rank,
     bool_or(rr.player_id=auth.uid()) is_me
   from public.round_runs rr join public.players p on p.id=rr.player_id
   where rr.session_id=p_session and rr.submitted_at is not null
   group by p.id,p.nickname
  ) board
 ), '[]'::jsonb);
end $$;
