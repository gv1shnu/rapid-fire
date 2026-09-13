-- Single-config, self-paced continuous rapid fire.
--
-- Before: the host configured and released each round (configure_round + go_live
-- + end_round), and every student was pinned to one session-wide current_round.
-- Now: the host configures ONCE and starts ONCE; all 9 rounds go live together
-- with the same config, and each student walks rounds 1->9 at their own pace with
-- no breaks and no per-round host action. "Round" is just a lecture/content label.
--
-- The proven per-(session,round) machinery is untouched -- release_questions
-- snapshots, tokened options, per-question timers, score_run, debriefs. Only the
-- control flow changes: fan one config out to 9 live releases, and move the round
-- pointer from the session to the player (derived from their submitted runs).

-- One config, all rounds live at once. Replaces the per-round configure_round + go_live loop.
create function public.start_rapid_fire(p_session uuid, p_count smallint, p_seconds smallint) returns void
language plpgsql security definer set search_path=public as $$
declare uid uuid; s public.sessions; t timestamptz; rid smallint;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for update;
 if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if s.status='closed' or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if s.status='live' then raise exception 'already_started'; end if;
 if p_count is null or p_count<1 or p_count>300 then raise exception 'invalid_question_count'; end if;
 if p_seconds is null or p_seconds<1 or p_seconds>120 then raise exception 'invalid_seconds'; end if;
 -- One count must fit every round; the smallest lecture pool caps it.
 if exists(select 1 from public.rounds rd where (select count(*) from public.questions q where q.round_id=rd.id) < p_count) then
  raise exception 'insufficient_question_pool';
 end if;
 t:=clock_timestamp();
 for rid in select id from public.rounds order by id loop
  insert into public.round_releases(session_id,round_id,question_count,seconds_per_question,status,started_at,closes_at,admission_closes_at)
   values(p_session,rid,p_count,p_seconds,'live',t,s.closes_at,s.closes_at)
   on conflict(session_id,round_id) do update set
    question_count=excluded.question_count,seconds_per_question=excluded.seconds_per_question,
    status='live',started_at=t,closes_at=excluded.closes_at,admission_closes_at=excluded.admission_closes_at;
  -- One count applies to every round (capped at the smallest pool), so questions
  -- are simply drawn uniformly at random -- no difficulty-split special cases.
  insert into public.release_questions(session_id,round_id,question_id,leg,snapshot)
  select p_session,rid,id,1,public.snapshot_question(id)
  from (select id from public.questions where round_id=rid order by random() limit p_count) x;
  if (select count(*) from public.release_questions where session_id=p_session and round_id=rid)<>p_count then
   raise exception 'insufficient_question_pool';
  end if;
 end loop;
 update public.sessions set status='live',current_round=1,started_at=coalesce(started_at,t) where id=p_session;
 perform realtime.send(jsonb_build_object('started',true),'rapid_fire_started','session:'||p_session,true);
end $$;

-- Enter a round on the player's own timeline: any round whose predecessors this
-- player has already submitted. No session-wide current_round gate.
create or replace function public.start_round(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cfg public.round_releases; q record; n integer:=0; ids bigint[]; r public.round_runs;
begin
 s:=public.assert_live(p_session); cfg:=public.assert_release(p_session,p_round);
 if p_round is null or p_round<1 or p_round>9 then raise exception 'round_out_of_order'; end if;
 if exists(select 1 from public.rounds rd where rd.id<p_round and not exists(
   select 1 from public.round_runs rr where rr.session_id=p_session and rr.player_id=auth.uid() and rr.round_id=rd.id and rr.submitted_at is not null))
 then raise exception 'round_out_of_order'; end if;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid();
 if r.session_id is null and clock_timestamp()>=cfg.admission_closes_at then raise exception 'admission_closed'; end if;
 insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question) values(p_session,auth.uid(),p_round,cfg.question_count,cfg.seconds_per_question) on conflict do nothing;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid() for update;
 if r.submitted_at is not null then return jsonb_build_object('round_complete',true,'round_id',p_round,'server_now',clock_timestamp()); end if;
 if not exists(select 1 from public.attempts where session_id=p_session and round_id=p_round and player_id=auth.uid()) then
  for q in select * from public.release_questions where session_id=p_session and round_id=p_round order by leg,random() loop
   n:=n+1;
   select array_agg((o->>'id')::bigint order by case when (q.snapshot->>'lock_order')::boolean then (o->>'id')::double precision else random() end) into ids from jsonb_array_elements(q.snapshot->'options') o;
   insert into public.attempts(session_id,player_id,round_id,seq,question_id,option_order) values(p_session,auth.uid(),p_round,n,q.question_id,ids);
  end loop;
  if n<>cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 end if;
 return public.serve_pending(p_session,p_round);
end $$;

-- Force-finalize every round at close, so a fast finisher's partial rounds and
-- any never-submitted rounds are scored once the sitting ends.
create function public.finalize_session(p_session uuid) returns void
language plpgsql security definer set search_path=public as $$
declare rid smallint;
begin
 for rid in select id from public.rounds order by id loop
  perform public.finish_release(p_session,rid,true);
 end loop;
end $$;

create or replace function public.end_session(p_session uuid) returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.sessions s join public.instructors i on i.id=s.host where s.id=p_session and s.host=uid) then raise exception 'host_only'; end if;
 perform public.finalize_session(p_session);
 update public.sessions set status='closed' where id=p_session;
 perform realtime.send('{}'::jsonb,'session_ended','session:'||p_session,true);
end $$;

-- The player's own position drives everything. current_round is their lowest
-- round with no submitted run (their next/in-progress round), null when all done.
create or replace function public.student_state(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cur smallint;
begin
 perform public.assert_domain();
 if not exists(select 1 from public.session_members where session_id=p_session and player_id=auth.uid()) then raise exception 'not_session_member'; end if;
 s:=public.assert_member(p_session);
 -- Once the sitting is over, finalize every started run so scores/results exist
 -- even for students who were mid-round when the timer ran out (idempotent).
 if s.status='closed' or (s.closes_at is not null and clock_timestamp()>=s.closes_at) then
  perform public.finalize_session(p_session);
 end if;
 select min(rd.id) into cur from public.rounds rd where not exists(
  select 1 from public.round_runs rr where rr.session_id=p_session and rr.player_id=auth.uid() and rr.round_id=rd.id and rr.submitted_at is not null);
 -- While live, advance only this player's active round clock (self-paced); it may auto-submit.
 if cur is not null and s.status='live' and clock_timestamp()<s.closes_at then
  perform public.expire_run(p_session,cur,auth.uid());
  select min(rd.id) into cur from public.rounds rd where not exists(
   select 1 from public.round_runs rr where rr.session_id=p_session and rr.player_id=auth.uid() and rr.round_id=rd.id and rr.submitted_at is not null);
 end if;
 return jsonb_build_object('session_id',s.id,
  'status',case when clock_timestamp()>=s.closes_at then 'closed' else s.status end,
  'current_round',cur,'done',cur is null,
  'can_start',s.status='live' and clock_timestamp()<s.closes_at and cur is not null,
  'server_now',clock_timestamp(),
  'results',(select coalesce(jsonb_agg(rr.round_id order by rr.round_id),'[]'::jsonb) from public.round_runs rr
    where rr.session_id=p_session and rr.player_id=auth.uid() and rr.submitted_at is not null
      and (s.status='closed' or clock_timestamp()>=s.closes_at)));
end $$;

-- Standings unlock once this player has finished every round, or the session is
-- over; they update live as classmates finish. Real names, never answers.
create or replace function public.session_leaderboard(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 s:=public.assert_member(p_session);
 if exists(select 1 from public.rounds rd where not exists(
    select 1 from public.round_runs rr where rr.session_id=p_session and rr.player_id=auth.uid() and rr.round_id=rd.id and rr.submitted_at is not null))
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

-- One overall view for the host: the shared config, the session, and progress.
create or replace function public.instructor_state(p_session uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.sessions; catalogue jsonb; cfg public.round_releases;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if p_session is not null then
  select * into s from public.sessions where id=p_session;
  if s.host is distinct from uid then raise exception 'host_only'; end if;
  select * into cfg from public.round_releases where session_id=p_session order by round_id limit 1;
 end if;
 select jsonb_agg(to_jsonb(r) order by r.id) into catalogue from (
  select rounds.id,rounds.title,count(q.id) as available_questions
  from public.rounds left join public.questions q on q.round_id=rounds.id group by rounds.id
 ) r;
 return jsonb_build_object('rounds',catalogue,
  'min_available',(select min(n) from (select count(q.id) n from public.rounds rd left join public.questions q on q.round_id=rd.id group by rd.id) c),
  'sections',(select jsonb_agg(section order by section) from (select distinct section from public.roster) t),
  'session',case when s.id is not null then jsonb_build_object('id',s.id,'code',s.code,
    'status',case when s.closes_at is not null and clock_timestamp()>=s.closes_at then 'closed' else s.status end,'closes_at',s.closes_at) end,
  'config',case when cfg.session_id is not null then jsonb_build_object('question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,
    'duration_seconds',cfg.question_count*cfg.seconds_per_question) end,
  'students_joined',(select count(*) from public.session_members where session_id=p_session),
  'students_done',(select count(*) from (
     select rr.player_id from public.round_runs rr where rr.session_id=p_session and rr.submitted_at is not null
     group by rr.player_id having count(*)=(select count(*) from public.rounds)) d),
  'server_now',clock_timestamp());
end $$;

-- Per-round host controls are gone; the frontend no longer calls them.
revoke execute on function public.configure_round(uuid,smallint,smallint,smallint),public.go_live(uuid,smallint),public.end_round(uuid,smallint),public.next_question(uuid,smallint) from authenticated;
grant execute on function public.start_rapid_fire(uuid,smallint,smallint) to authenticated;
revoke execute on function public.start_rapid_fire(uuid,smallint,smallint) from public,anon;
revoke execute on function public.finalize_session(uuid) from public,anon,authenticated;
