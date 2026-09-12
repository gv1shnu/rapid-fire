-- Final standings for the whole rapid fire, revealed to members only once the
-- session is over. Kept sealed while play is live so nobody races a live board.
create function public.session_leaderboard(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 s:=public.assert_member(p_session);
 if s.status<>'closed' and (s.closes_at is null or clock_timestamp()<s.closes_at) then
  raise exception 'leaderboard_not_released';
 end if;
 return coalesce((
  select jsonb_agg(board order by board.rank, lower(board.nickname))
  from (
   select p.nickname,
     sum(rr.total_points)::int points,
     rank() over(order by sum(rr.total_points) desc, sum(rr.total_time)) rank,
     bool_or(rr.player_id=auth.uid()) is_me
   from public.round_runs rr join public.players p on p.id=rr.player_id
   where rr.session_id=p_session and rr.submitted_at is not null
   group by p.id,p.nickname
  ) board
 ), '[]'::jsonb);
end $$;
revoke execute on function public.session_leaderboard(uuid) from public,anon,authenticated;
grant execute on function public.session_leaderboard(uuid) to authenticated;
