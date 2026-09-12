-- The leaderboard and the solutions unlock on different clocks:
--  * Standings become visible to a student the moment they have submitted, and
--    update in real time as classmates finish. They never expose answers.
--  * Solutions (the debrief) stay sealed for everyone until the whole rapid fire
--    is over -- unchanged from 010's `my_result` / `student_state` gate.
-- So a student who finishes sees where they rank without being handed the key to
-- pass to peers who are still playing.
create or replace function public.session_leaderboard(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 s:=public.assert_member(p_session);
 if not exists(select 1 from public.round_runs where session_id=p_session and player_id=auth.uid() and submitted_at is not null)
    and s.status<>'closed' and (s.closes_at is null or clock_timestamp()<s.closes_at) then
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
