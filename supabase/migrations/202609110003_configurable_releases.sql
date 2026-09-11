-- Instructor-approved per-round releases. Configuration freezes at release.
create table public.round_releases (
  session_id uuid not null references public.sessions,
  round_id smallint not null references public.rounds,
  question_count smallint not null default 30 check (question_count between 1 and 300),
  seconds_per_question smallint not null default 12 check (seconds_per_question between 1 and 120),
  status text not null default 'draft' check (status in ('draft','live','ended')),
  started_at timestamptz,
  closes_at timestamptz,
  ended_at timestamptz,
  primary key (session_id, round_id)
);
alter table public.round_releases enable row level security;
revoke all on public.round_releases from public, anon, authenticated;
alter table public.attempts drop constraint attempts_seq_check;
alter table public.attempts add constraint attempts_seq_check check (seq between 1 and 300);
alter table public.attempts add column forced_timeout boolean not null default false;
alter table public.round_runs
  add column question_count smallint not null default 30 check (question_count between 1 and 300),
  add column seconds_per_question smallint not null default 12 check (seconds_per_question between 1 and 120);
alter table public.round_runs drop column average_answer_seconds, drop column accuracy_percent;
alter table public.round_runs
  add column average_answer_seconds numeric generated always as
    (case when submitted_at is not null then total_time / question_count end) stored,
  add column accuracy_percent numeric generated always as
    (correct_count * 100.0 / question_count) stored;
alter table public.round_runs drop constraint complete_round_metrics;
alter table public.round_runs add constraint complete_round_metrics check (
  (submitted_at is null and correct_count is null and wrong_count is null
    and timeout_count is null and under_half_count is null)
  or
  (submitted_at is not null and correct_count is not null and wrong_count is not null
    and timeout_count is not null and under_half_count is not null
    and correct_count between 0 and question_count and wrong_count between 0 and question_count
    and timeout_count between 0 and question_count
    and correct_count + wrong_count + timeout_count = question_count
    and under_half_count between 0 and correct_count + wrong_count)
);
-- Preserve existing active/completed sessions during upgrades.
insert into public.round_releases(session_id,round_id,status,started_at,closes_at,ended_at)
select s.id,s.current_round,case when s.status='closed' then 'ended' else 'live' end,
  coalesce(s.started_at,clock_timestamp()),s.closes_at,
  case when s.status='closed' then clock_timestamp() end
from public.sessions s where s.current_round is not null;
create or replace function public.capture_round_metrics()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- The scoring function has already updated every attempt's points.
  select
    count(*) filter (where a.points > 0),
    count(*) filter (where a.points = 0 and a.option_id is not null
      and a.answered_at <= a.served_at + make_interval(secs => new.seconds_per_question + 1)),
    count(*) filter (where a.option_id is null
      or a.answered_at > a.served_at + make_interval(secs => new.seconds_per_question + 1)),
    count(*) filter (where a.option_id is not null
      and a.answered_at >= a.served_at
      and a.answered_at < a.served_at + make_interval(secs => new.seconds_per_question / 2.0))
  into new.correct_count, new.wrong_count, new.timeout_count, new.under_half_count
  from public.attempts a
  where a.session_id = new.session_id and a.player_id = new.player_id
    and a.round_id = new.round_id and (a.answered_at is not null or a.forced_timeout);
  if new.correct_count + new.wrong_count + new.timeout_count <> new.question_count then
    raise exception 'round_incomplete';
  end if;
  return new;
end;
$$;

create function public.assert_release(p_session uuid, p_round smallint)
returns public.round_releases language plpgsql security definer set search_path = public as $$
declare cfg public.round_releases;
begin
  select * into cfg from public.round_releases where session_id=p_session and round_id=p_round;
  if cfg.session_id is null or cfg.status<>'live' or clock_timestamp()>=cfg.closes_at then
    raise exception 'round_ended';
  end if;
  return cfg;
end $$;
create or replace function public.lock_round(p_session uuid,p_round smallint) returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; r public.round_runs;
begin
 s:=public.assert_live(p_session);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 perform public.assert_release(p_session,p_round);
 select * into r from public.round_runs where session_id=p_session and player_id=auth.uid() and round_id=p_round for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is not null then raise exception 'round_already_submitted'; end if;
end $$;
create or replace function public.start_round(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; q record; n integer:=0; ids bigint[]; cfg public.round_releases;
begin
 s:=public.assert_live(p_session);
 cfg:=public.assert_release(p_session,p_round);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question) values(p_session,auth.uid(),p_round,cfg.question_count,cfg.seconds_per_question) on conflict do nothing;
 perform public.lock_round(p_session,p_round);
 if exists(select 1 from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round) then return public.serve_pending(p_session,p_round); end if;
 if (select count(*) from public.questions where round_id=p_round)<cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 for q in
 with ranked as (
   select id,lock_order,difficulty,row_number() over(partition by difficulty order by random()) rn
   from public.questions where round_id=p_round
 ), drawn as (
   select *,case when difficulty='easy' then 1 when difficulty='medium' and rn<=10 then 2 else 3 end leg
   from ranked
   where cfg.question_count<>30 or (difficulty='easy' and rn<=10)
     or (difficulty='medium' and rn<=14) or (difficulty='hard' and rn<=6)
 ), selected as (
   select * from drawn order by case when cfg.question_count<>30 then random() else 0 end
   limit cfg.question_count
 )
 select * from selected order by leg,random()
 loop
 n:=n+1;
 select array_agg(id order by case when q.lock_order then id::double precision else random() end) into ids from public.options where question_id=q.id;
 insert into public.attempts(session_id,player_id,round_id,seq,question_id,option_order) values(p_session,auth.uid(),p_round,n,q.id,ids);
 end loop;
 if n<>cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 return public.serve_pending(p_session,p_round);
end $$;
create or replace function public.serve_pending(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; q public.questions; opts jsonb; cfg public.round_releases;
begin
 cfg:=public.assert_release(p_session,p_round);
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and answered_at is null order by seq limit 1 for update;
 if a.seq is null then return jsonb_build_object('round_complete',true); end if;
 if a.served_at is null then
 update public.attempts set served_at=clock_timestamp() where session_id=p_session and player_id=auth.uid() and round_id=p_round and seq=a.seq returning * into a;
 end if;
 select * into q from public.questions where id=a.question_id;
 select jsonb_agg(jsonb_build_object('id',o.id,'body',jsonb_strip_nulls(jsonb_build_object('text',o.body->'text','table_json',o.body->'table_json'))) order by x.ord) into opts
 from unnest(a.option_order) with ordinality x(id,ord) join public.options o on o.id=x.id;
 return jsonb_build_object('seq',a.seq,'question_id',q.id,'display_type',q.display_type,'stem',q.stem,
 'body',jsonb_strip_nulls(jsonb_build_object('code_html',q.body->'code_html','table_json',q.body->'table_json','image_ref',q.body->'image_ref')),
 'options',opts,'served_at',a.served_at,'deadline',least(a.served_at+make_interval(secs => cfg.seconds_per_question),cfg.closes_at),'server_now',clock_timestamp(),'question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,'round_closes_at',cfg.closes_at);
end $$;
create or replace function public.submit_answer(p_session uuid,p_round smallint,seq smallint,option_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; t timestamptz; cfg public.round_releases;
begin
 perform public.lock_round(p_session,p_round);
 cfg:=public.assert_release(p_session,p_round);
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and attempts.seq=submit_answer.seq;
 if a.seq is null or a.served_at is null then raise exception 'question_not_served'; end if;
 -- Retries are immutable and return the same pending question without resetting its clock.
 if a.answered_at is not null then return public.serve_pending(p_session,p_round); end if;
 if option_id is not null and not(option_id=any(a.option_order)) then raise exception 'invalid_option'; end if;
 t:=clock_timestamp();
 if t>=cfg.closes_at then raise exception 'round_ended'; end if;
 if option_id is null and t<a.served_at+make_interval(secs => cfg.seconds_per_question) then raise exception 'answer_required'; end if;
 update public.attempts set answered_at=t,option_id=case when t<=a.served_at+make_interval(secs => cfg.seconds_per_question+1) then submit_answer.option_id else null end
 where session_id=p_session and player_id=auth.uid() and round_id=p_round and attempts.seq=a.seq;
 return public.serve_pending(p_session,p_round);
end $$;
create or replace function public.score_run(p_session uuid,p_round smallint,p_player uuid,p_force boolean default false,p_cutoff timestamptz default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.round_runs; a record; streak integer:=0; best integer:=0; total integer:=0; pts integer; elapsed numeric:=0; items jsonb:='[]'; result jsonb; position bigint;
begin
 select * into r from public.round_runs where session_id=p_session and player_id=p_player and round_id=p_round for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is not null then return r.debrief; end if;
 if p_force then
   update public.attempts set forced_timeout=true,option_id=null,
     answered_at=case when served_at is not null then greatest(served_at,p_cutoff) else null end
   where session_id=p_session and player_id=p_player and round_id=p_round and answered_at is null;
 end if;

 if (select count(*) from public.attempts where session_id=p_session and player_id=p_player and round_id=p_round and (answered_at is not null or forced_timeout))<>r.question_count then raise exception 'round_incomplete'; end if;
 for a in select at.*,o.id correct_id,q.explanation from public.attempts at join public.questions q on q.id=at.question_id join public.options o on o.question_id=q.id and o.is_correct
 where at.session_id=p_session and at.player_id=p_player and at.round_id=p_round order by at.seq loop
 if not a.forced_timeout and a.option_id=a.correct_id and a.answered_at<=a.served_at+make_interval(secs => r.seconds_per_question+1) then
 streak:=streak+1;
 pts:=round((100+50*greatest(0,r.seconds_per_question-extract(epoch from a.answered_at-a.served_at))/r.seconds_per_question)*(case when streak>=6 then 1.5 when streak>=3 then 1.2 else 1 end));
 else streak:=0;pts:=0;end if;
 best:=greatest(best,streak);total:=total+pts;elapsed:=elapsed+greatest(0,extract(epoch from a.answered_at-a.served_at));
 update public.attempts set points=pts where session_id=p_session and player_id=p_player and round_id=p_round and seq=a.seq;
 items:=items||jsonb_build_array(jsonb_build_object('seq',a.seq,'question_id',a.question_id,'chosen_option',a.option_id,'correct_option',a.correct_id,'explanation',a.explanation,'points',pts));
 end loop;
 update public.round_runs set submitted_at=clock_timestamp(),total_points=total,total_time=elapsed,best_streak=best where session_id=p_session and player_id=p_player and round_id=p_round;
 select rank into position from (select player_id,rank() over(order by sum(total_points) desc,sum(total_time)) from public.round_runs where session_id=p_session and submitted_at is not null group by player_id) ranks where player_id=p_player;
 result:=jsonb_build_object('round_id',p_round,'question_count',r.question_count,'seconds_per_question',r.seconds_per_question,'total_points',total,'best_streak',best,'questions',items,'cumulative_points',(select sum(total_points) from public.round_runs where session_id=p_session and player_id=p_player and submitted_at is not null),'leaderboard_position',position);
 update public.round_runs set debrief=result where session_id=p_session and player_id=p_player and round_id=p_round;
 return result;
end $$;

create or replace function public.submit_round(p_session uuid,p_round smallint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions;
begin
  s:=public.assert_live(p_session);
  perform public.assert_release(p_session,p_round);
  if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
  return public.score_run(p_session,p_round,auth.uid());
end $$;

create function public.finish_release(p_session uuid,p_round smallint,p_manual boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare cfg public.round_releases; s public.sessions; r record; cutoff timestamptz;
begin
  select * into s from public.sessions where id=p_session for update;
  select * into cfg from public.round_releases where session_id=p_session and round_id=p_round for update;
  if cfg.session_id is null or cfg.status<>'live' then return; end if;
  cutoff:=least(cfg.closes_at,s.closes_at,clock_timestamp());
  if not p_manual and clock_timestamp()<least(cfg.closes_at,s.closes_at) and s.status<>'closed' then return; end if;
  for r in select player_id from public.round_runs
    where session_id=p_session and round_id=p_round and submitted_at is null order by player_id
  loop
    perform public.score_run(p_session,p_round,r.player_id,true,cutoff);
  end loop;
  update public.round_releases set status='ended',ended_at=cutoff
    where session_id=p_session and round_id=p_round;
end $$;

create function public.configure_round(p_session uuid,p_round smallint,p_count smallint,p_seconds smallint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid; available integer;
begin
  uid:=public.assert_domain();
  select * into s from public.sessions where id=p_session for update;
  if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
  if s.status='closed' or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
  if p_round is null or p_round<>coalesce(s.current_round,0)+1 or p_round>9 then raise exception 'round_out_of_order'; end if;
  select count(*) into available from public.questions where round_id=p_round;
  if p_count is null or p_count<1 or p_count>least(available,300) then raise exception 'invalid_question_count'; end if;
  if p_seconds is null or p_seconds not between 1 and 120 then raise exception 'invalid_question_seconds'; end if;
  if exists(select 1 from public.round_releases where session_id=p_session and round_id=p_round and status<>'draft') then raise exception 'release_locked'; end if;
  insert into public.round_releases(session_id,round_id,question_count,seconds_per_question)
    values(p_session,p_round,p_count,p_seconds)
  on conflict(session_id,round_id) do update set question_count=excluded.question_count,seconds_per_question=excluded.seconds_per_question;
  return jsonb_build_object('available_questions',available,'question_count',p_count,
    'seconds_per_question',p_seconds,'duration_seconds',p_count*p_seconds,'status','draft');
end $$;

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
  if t+make_interval(secs => cfg.question_count*cfg.seconds_per_question)>s.closes_at then raise exception 'release_exceeds_session_window'; end if;
  update public.round_releases set status='ended',ended_at=t where session_id=p_session and status='live';
  update public.round_releases set status='live',started_at=t,closes_at=t+make_interval(secs => question_count*seconds_per_question)
    where session_id=p_session and round_id=p_round;
  update public.sessions set status='live',current_round=p_round,started_at=coalesce(started_at,t) where id=p_session;
  perform realtime.send(jsonb_build_object('round',p_round),'round_started','session:'||p_session,true);
end $$;

create function public.end_round(p_session uuid,p_round smallint)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  uid:=public.assert_domain();
  if not exists(select 1 from public.sessions s join public.instructors i on i.id=s.host where s.id=p_session and s.host=uid) then raise exception 'host_only'; end if;
  perform public.finish_release(p_session,p_round,true);
end $$;
create or replace function public.end_session(p_session uuid) returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.sessions s join public.instructors i on i.id=s.host where s.id=p_session and s.host=uid) then raise exception 'host_only'; end if;
 perform public.finish_release(p_session,(select current_round from public.sessions where id=p_session),true);
 update public.sessions set status='closed' where id=p_session;
 perform realtime.send('{}'::jsonb,'session_ended','session:'||p_session,true);
end $$;
create or replace function public.round_report(p_session uuid, p_round smallint)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid;
  s public.sessions;
  students jsonb;
  questions jsonb;
  summary jsonb;
begin
  uid := public.assert_domain();
  select * into s from public.sessions where id = p_session for update;
  if s.host is distinct from uid
    or not exists (select 1 from public.instructors where id = uid) then
    raise exception 'host_only';
  end if;
  perform public.finish_release(p_session,p_round);
  if s.status <> 'closed' and (s.closes_at is null or clock_timestamp() < s.closes_at) and not exists(select 1 from public.round_releases where session_id=p_session and round_id=p_round and status='ended') then
    raise exception 'report_available_after_session';
  end if;
  if p_round is null or not exists (select 1 from public.rounds where id = p_round) then
    raise exception 'invalid_round';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id', r.player_id,
    'nickname', p.nickname,
    'score', r.total_points,
    'correct_count', r.correct_count,
    'wrong_count', r.wrong_count,
    'timeout_count', r.timeout_count,
    'total_answer_seconds', r.total_time,
    'average_answer_seconds', r.average_answer_seconds,
    'accuracy_percent', r.accuracy_percent,
    'answers_under_half_time', r.under_half_count,
    'submitted_at', r.submitted_at
  ) order by r.total_points desc, r.total_time, r.player_id), '[]'::jsonb)
  into students
  from public.round_runs r join public.players p on p.id = r.player_id
  where r.session_id = p_session and r.round_id = p_round and r.submitted_at is not null;

  select jsonb_build_object(
    'submitted_students', count(*),
    'incomplete_students', (select count(*) from public.round_runs
      where session_id = p_session and round_id = p_round and submitted_at is null),
    'average_score', avg(total_points),
    'average_correct_count', avg(correct_count),
    'average_wrong_count', avg(wrong_count),
    'average_timeout_count', avg(timeout_count),
    'average_round_answer_seconds', avg(total_time),
    'average_answer_seconds', avg(average_answer_seconds),
    'average_accuracy_percent', avg(accuracy_percent),
    'students_with_under_half_answers', count(*) filter (where under_half_count > 0),
    'answers_under_half_time', coalesce(sum(under_half_count), 0)
  ) into summary
  from public.round_runs
  where session_id = p_session and round_id = p_round and submitted_at is not null;

  -- Different draws mean different denominators. Count only submitted students
  -- who actually received this question, never everyone who joined the session.
  select coalesce(jsonb_agg(to_jsonb(q) order by q.question_id), '[]'::jsonb)
  into questions
  from (
    select a.question_id,
      count(*) as submitted_students,
      count(*) filter (where a.points > 0) as correct_count,
      count(*) filter (where a.points = 0 and a.option_id is not null
        and a.answered_at <= a.served_at + make_interval(secs => r.seconds_per_question+1)) as wrong_count,
      count(*) filter (where a.option_id is null
        or a.answered_at > a.served_at + make_interval(secs => r.seconds_per_question+1)) as timeout_count,
      avg(greatest(0, extract(epoch from a.answered_at - a.served_at))) as average_answer_seconds,
      100.0 * count(*) filter (where a.points > 0) / count(*) as accuracy_percent,
      count(*) filter (where a.option_id is not null
        and a.answered_at >= a.served_at
        and a.answered_at < a.served_at + make_interval(secs => r.seconds_per_question/2.0)) as students_under_half_time
    from public.attempts a join public.round_runs r
      on r.session_id = a.session_id and r.player_id = a.player_id and r.round_id = a.round_id
    where a.session_id = p_session and a.round_id = p_round and r.submitted_at is not null
    group by a.question_id
  ) q;

  return jsonb_build_object('session_id', p_session, 'round_id', p_round,
    'half_time_seconds', (select seconds_per_question/2.0 from public.round_releases where session_id=p_session and round_id=p_round), 'summary', summary, 'students', students, 'questions', questions);
end;
$$;

create function public.instructor_state(p_session uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.sessions; catalogue jsonb; release jsonb;
begin
  uid:=public.assert_domain();
  if not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
  if p_session is not null then
    select * into s from public.sessions where id=p_session;
    if s.host is distinct from uid then raise exception 'host_only'; end if;
    perform public.finish_release(p_session,s.current_round);
    select to_jsonb(r)||jsonb_build_object('duration_seconds',r.question_count*r.seconds_per_question,
      'submitted_students',(select count(*) from public.round_runs where session_id=p_session and round_id=r.round_id and submitted_at is not null))
    into release from public.round_releases r where session_id=p_session order by round_id desc limit 1;
  end if;
  select jsonb_agg(to_jsonb(r) order by r.id) into catalogue from (
    select rounds.id,rounds.title,count(q.id) as available_questions
    from public.rounds left join public.questions q on q.round_id=rounds.id group by rounds.id
  ) r;
  return jsonb_build_object('rounds',catalogue,'sections',(select jsonb_agg(section order by section) from (select distinct section from public.roster) t),
    'session',case when s.id is not null then jsonb_build_object('id',s.id,'code',s.code,'status',s.status,'current_round',s.current_round,'closes_at',s.closes_at) end,
    'release',release,'server_now',clock_timestamp());
end $$;

revoke execute on function public.assert_release(uuid,smallint),public.score_run(uuid,smallint,uuid,boolean,timestamptz),public.finish_release(uuid,smallint,boolean),public.configure_round(uuid,smallint,smallint,smallint),public.end_round(uuid,smallint),public.instructor_state(uuid) from public,anon,authenticated;
grant execute on function public.configure_round(uuid,smallint,smallint,smallint),public.end_round(uuid,smallint),public.instructor_state(uuid) to authenticated;
