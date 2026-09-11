-- Per-question timing needs slack at the round boundary. The round's closes_at
-- used to equal start + count*seconds, so the LAST (or only) question's
-- deadline landed exactly on closes_at — answering or timing it out at 0 was
-- rejected as 'round_ended', so the round never completed and no debrief showed.
-- Give the window one extra question of grace so the final answer always lands
-- while the release is still live.
create or replace function public.go_live(p_session uuid,p_round smallint)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid; cfg public.round_releases; t timestamptz;
begin
  uid:=public.assert_domain();
  select * into s from public.sessions where id=p_session for update;
  if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
  if s.status='closed' or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
  if p_round is null or p_round<>coalesce(s.current_round,0)+1 or p_round>9 then raise exception 'round_out_of_order'; end if;
  perform public.finish_release(p_session,s.current_round);
  if exists(select 1 from public.round_runs where session_id=p_session and round_id=s.current_round and submitted_at is null) then raise exception 'players_still_answering'; end if;
  insert into public.round_releases(session_id,round_id) values(p_session,p_round) on conflict do nothing;
  select * into cfg from public.round_releases where session_id=p_session and round_id=p_round for update;
  if cfg.status<>'draft' then raise exception 'release_locked'; end if;
  if (select count(*) from public.questions where round_id=p_round)<cfg.question_count then raise exception 'insufficient_question_pool'; end if;
  t:=clock_timestamp();
  if t+make_interval(secs => (cfg.question_count+1)*cfg.seconds_per_question)>s.closes_at then raise exception 'release_exceeds_session_window'; end if;
  update public.round_releases set status='ended',ended_at=t where session_id=p_session and status='live';
  update public.round_releases set status='live',started_at=t,closes_at=t+make_interval(secs => (question_count+1)*seconds_per_question)
    where session_id=p_session and round_id=p_round;
  update public.sessions set status='live',current_round=p_round,started_at=coalesce(started_at,t) where id=p_session;
  perform realtime.send(jsonb_build_object('round',p_round),'round_started','session:'||p_session,true);
end $$;
