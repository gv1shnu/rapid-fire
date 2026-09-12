-- Apply between sittings: the student wire protocol changes to UUID option tokens.
-- Existing live releases retain their hard cutoff; new releases separate admission
-- from per-question clocks. Never reset a served timestamp during recovery.
do $$begin
 if exists(select 1 from public.round_releases r join public.sessions s on s.id=r.session_id where r.status='live' and s.status='live' and clock_timestamp()<least(r.closes_at,s.closes_at)) then
  raise exception 'end_live_releases_before_protocol_upgrade';
 end if;
end $$;
-- Historical scores retain their original acceptance rule; new attempts have no grace.
alter table public.round_runs add column deadline_grace_seconds smallint not null default 0 check(deadline_grace_seconds in (0,1));
update public.round_runs set deadline_grace_seconds=1;
create function public.answer_in_time(served timestamptz,answered timestamptz,seconds integer,grace integer) returns boolean
language sql immutable set search_path=public as $$
 select served is not null and answered is not null and answered>=served and
 case when grace=0 then answered<served+make_interval(secs=>seconds)
 else answered<=served+make_interval(secs=>seconds+grace) end
$$;
revoke execute on function public.answer_in_time(timestamptz,timestamptz,integer,integer) from public,anon,authenticated;
delete from public.allowed_domains where domain not in ('example.edu','students.example.edu');
insert into public.allowed_domains values ('example.edu'),('students.example.edu') on conflict do nothing;

create table public.session_members (
 session_id uuid references public.sessions not null,
 player_id uuid references public.players not null,
 joined_at timestamptz not null default clock_timestamp(),
 primary key(session_id,player_id)
);
-- Only historical attempts prove membership; a matching section does not.
insert into public.session_members(session_id,player_id)
select distinct session_id,player_id from public.round_runs;
alter table public.session_members enable row level security;
revoke all on public.session_members from public,anon,authenticated;
alter table public.round_releases add column admission_closes_at timestamptz;
update public.round_releases set admission_closes_at=closes_at;
alter table public.attempts add column option_tokens uuid[] not null default array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
alter table public.attempts add constraint four_option_tokens check(cardinality(option_tokens)=4);
create table public.release_questions (
 session_id uuid not null, round_id smallint not null, question_id bigint not null references public.questions,
 leg smallint not null, snapshot jsonb not null,
 primary key(session_id,round_id,question_id),
 foreign key(session_id,round_id) references public.round_releases
);
alter table public.release_questions enable row level security;
revoke all on public.release_questions from public,anon,authenticated;

-- A schema allowlist at every nesting level. Unknown metadata is never serialized.
create function public.safe_table(value jsonb) returns jsonb
language plpgsql immutable set search_path=public as $$
declare result jsonb; row_value jsonb;
begin
 if jsonb_typeof(value)<>'object' or jsonb_typeof(value->'cols') is distinct from 'array'
 or jsonb_typeof(value->'rows') is distinct from 'array' then return null; end if;
 if exists(select 1 from jsonb_array_elements(value->'cols') x where jsonb_typeof(x)<>'string') then return null; end if;
 for row_value in select * from jsonb_array_elements(value->'rows') loop
  if jsonb_typeof(row_value)<>'array' then return null; end if;
  if exists(select 1 from jsonb_array_elements(row_value) x where jsonb_typeof(x) not in ('string','number','boolean','null')) then return null; end if;
 end loop;
 result:=jsonb_build_object('cols',value->'cols','rows',value->'rows');
 return result;
end $$;
create function public.safe_body(value jsonb) returns jsonb
language sql immutable set search_path=public as $$
 select jsonb_strip_nulls(jsonb_build_object(
 'text',case when jsonb_typeof(value->'text')='string' then value->'text' end,
 'code_html',case when jsonb_typeof(value->'code_html')='string' then value->'code_html' end,
 'table_json',public.safe_table(value->'table_json')))
$$;
create function public.snapshot_question(qid bigint) returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object('stem',q.stem,'display_type',q.display_type,'body',public.safe_body(q.body),
 'explanation',q.explanation,'lock_order',q.lock_order,
 'options',(select jsonb_agg(jsonb_build_object('id',o.id,'body',public.safe_body(o.body),'is_correct',o.is_correct) order by o.id) from public.options o where o.question_id=q.id))
 from public.questions q where q.id=qid
$$;
insert into public.release_questions
select distinct r.session_id,r.round_id,a.question_id,1,public.snapshot_question(a.question_id)
from public.round_releases r join public.attempts a using(session_id,round_id);

create function public.assert_member(p_session uuid) returns public.sessions
language plpgsql security definer set search_path=public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for share;
 if s.id is null or not exists(select 1 from public.session_members where session_id=p_session and player_id=uid) then raise exception 'not_session_member'; end if;
 return s;
end $$;
create or replace function public.assert_live(p_session uuid) returns public.sessions
language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 s:=public.assert_member(p_session);
 if s.status<>'live' or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 return s;
end $$;
create or replace function public.join_session(code text,nickname text,avatar_seed text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 if code is null or upper(trim(code)) !~ '^[A-Z]{6}$' then raise exception 'invalid_join_code'; end if;
 select * into s from public.sessions where sessions.code=upper(trim($1)) for share;
 if s.id is null then raise exception 'session_unavailable'; end if;
 if not exists(select 1 from public.session_members where session_id=s.id and player_id=uid) then
  if s.status not in ('lobby','live') or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
  insert into public.players values(uid,s.section,trim(nickname),avatar_seed) on conflict(id) do nothing;
  insert into public.session_members(session_id,player_id) values(s.id,uid) on conflict do nothing;
 end if;
 return jsonb_build_object('session_id',s.id);
end $$;

-- Freeze the draw AND content once. Question-bank edits cannot affect a sitting.
create or replace function public.go_live(p_session uuid,p_round smallint) returns void
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cfg public.round_releases; uid uuid; t timestamptz;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for update;
 if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if s.status='closed' or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if p_round is null or p_round<>coalesce(s.current_round,0)+1 or p_round>9 then raise exception 'round_out_of_order'; end if;
 perform public.finish_release(p_session,s.current_round);
 if exists(select 1 from public.round_releases where session_id=p_session and round_id=s.current_round and status='live') then raise exception 'end_previous_round_first'; end if;
 insert into public.round_releases(session_id,round_id) values(p_session,p_round) on conflict do nothing;
 select * into cfg from public.round_releases where session_id=p_session and round_id=p_round for update;
 if cfg.status<>'draft' then raise exception 'release_locked'; end if;
 t:=clock_timestamp();
 if t+make_interval(secs=>cfg.question_count*cfg.seconds_per_question)>s.closes_at then raise exception 'release_exceeds_session_window'; end if;
 insert into public.release_questions(session_id,round_id,question_id,leg,snapshot)
 with ranked as (
  select id,difficulty,row_number() over(partition by difficulty order by random()) rn from public.questions where round_id=p_round
 ), selected as (
  select *,case when cfg.question_count<>30 then 1 when difficulty='easy' then 1 when difficulty='medium' and rn<=10 then 2 else 3 end leg
  from ranked where cfg.question_count<>30 or (difficulty='easy' and rn<=10) or (difficulty='medium' and rn<=14) or (difficulty='hard' and rn<=6)
  order by random() limit cfg.question_count
 ) select p_session,p_round,id,leg,public.snapshot_question(id) from selected;
 if (select count(*) from public.release_questions where session_id=p_session and round_id=p_round)<>cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 update public.round_releases set status='live',started_at=t,closes_at=s.closes_at,
 admission_closes_at=t+make_interval(secs=>question_count*seconds_per_question) where session_id=p_session and round_id=p_round;
 update public.sessions set status='live',current_round=p_round,started_at=coalesce(started_at,t) where id=p_session;
end $$;

-- Expired questions advance on their original deadlines even when a tab is offline.
-- The next question after an accepted answer starts only when it is first served.
create function public.expire_run(p_session uuid,p_round smallint,p_player uuid) returns void
language plpgsql security definer set search_path=public as $$
declare r public.round_runs; a public.attempts; boundary timestamptz;
begin
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=p_player for update;
 if r.session_id is null or r.submitted_at is not null then return; end if;
 loop
  select * into a from public.attempts where session_id=p_session and round_id=p_round and player_id=p_player and answered_at is null and not forced_timeout order by seq limit 1;
  if a.seq is null or a.served_at is null then exit; end if;
  boundary:=a.served_at+make_interval(secs=>r.seconds_per_question);
  if clock_timestamp()<boundary then exit; end if;
  update public.attempts set answered_at=boundary,option_id=null where session_id=p_session and round_id=p_round and player_id=p_player and seq=a.seq;
  update public.attempts set served_at=boundary where session_id=p_session and round_id=p_round and player_id=p_player and seq=a.seq+1 and served_at is null;
 end loop;
 if not exists(select 1 from public.attempts where session_id=p_session and round_id=p_round and player_id=p_player and answered_at is null and not forced_timeout) then
  perform public.score_run(p_session,p_round,p_player);
 end if;
end $$;
create or replace function public.serve_pending(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.attempts; snap jsonb; opts jsonb; cfg public.round_releases;
begin
 cfg:=public.assert_release(p_session,p_round);
 perform public.expire_run(p_session,p_round,auth.uid());
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and answered_at is null and not forced_timeout order by seq limit 1 for update;
 if a.seq is null then return jsonb_build_object('round_complete',true,'round_id',p_round,'server_now',clock_timestamp()); end if;
 if a.served_at is null then
  update public.attempts set served_at=clock_timestamp() where session_id=p_session and player_id=auth.uid() and round_id=p_round and seq=a.seq returning * into a;
 end if;
 select snapshot into snap from public.release_questions where session_id=p_session and round_id=p_round and question_id=a.question_id;
 select jsonb_agg(jsonb_build_object('id',a.option_tokens[x.ord],'body',o->'body') order by x.ord) into opts
 from unnest(a.option_order) with ordinality x(id,ord) join jsonb_array_elements(snap->'options') o on (o->>'id')::bigint=x.id;
 return jsonb_build_object('session_id',p_session,'round_id',p_round,'seq',a.seq,'stem',snap->'stem','display_type',snap->'display_type','body',snap->'body',
 'options',opts,'served_at',a.served_at,'deadline',a.served_at+make_interval(secs=>cfg.seconds_per_question),'server_now',clock_timestamp(),'question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question);
end $$;
create or replace function public.start_round(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cfg public.round_releases; q record; n integer:=0; ids bigint[]; r public.round_runs;
begin
 s:=public.assert_live(p_session); cfg:=public.assert_release(p_session,p_round);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid();
 if r.session_id is null and clock_timestamp()>=cfg.admission_closes_at then raise exception 'admission_closed'; end if;
 insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question) values(p_session,auth.uid(),p_round,cfg.question_count,cfg.seconds_per_question) on conflict do nothing;
 -- Session share lock precedes the per-player row lock in every student mutation.
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
-- Remove the exploitable numeric-ID protocol, including its grant.
drop function public.submit_answer(uuid,smallint,smallint,bigint);
create function public.submit_answer(p_session uuid,p_round smallint,seq smallint,option_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.attempts; cfg public.round_releases; r public.round_runs; t timestamptz; idx integer;
begin
 perform public.assert_live(p_session); cfg:=public.assert_release(p_session,p_round);
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid() for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is not null then return jsonb_build_object('round_complete',true,'round_id',p_round,'server_now',clock_timestamp()); end if;
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and attempts.seq=submit_answer.seq;
 if a.seq is null or a.served_at is null then raise exception 'question_not_served'; end if;
 if a.answered_at is not null then return public.serve_pending(p_session,p_round); end if;
 idx:=array_position(a.option_tokens,option_id);
 if option_id is not null and idx is null then raise exception 'invalid_option'; end if;
 t:=clock_timestamp();
 if t>=a.served_at+make_interval(secs=>cfg.seconds_per_question) then return public.serve_pending(p_session,p_round); end if;
 if option_id is null then raise exception 'answer_required'; end if;
 update public.attempts set answered_at=t,option_id=a.option_order[idx] where session_id=p_session and round_id=p_round and player_id=auth.uid() and attempts.seq=a.seq;
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
     answered_at=case when served_at is not null then greatest(served_at,least(p_cutoff,served_at+make_interval(secs=>r.seconds_per_question))) else null end
   where session_id=p_session and player_id=p_player and round_id=p_round and answered_at is null;
 end if;

 if (select count(*) from public.attempts where session_id=p_session and player_id=p_player and round_id=p_round and (answered_at is not null or forced_timeout))<>r.question_count then raise exception 'round_incomplete'; end if;
 for a in select at.*,(o->>'id')::bigint correct_id,q.snapshot->>'explanation' explanation,q.snapshot from public.attempts at join public.release_questions q on q.session_id=at.session_id and q.round_id=at.round_id and q.question_id=at.question_id cross join lateral jsonb_array_elements(q.snapshot->'options') o
 where (o->>'is_correct')::boolean and at.session_id=p_session and at.player_id=p_player and at.round_id=p_round order by at.seq loop
 if not a.forced_timeout and a.option_id=a.correct_id and public.answer_in_time(a.served_at,a.answered_at,r.seconds_per_question,r.deadline_grace_seconds) then
 streak:=streak+1;
 pts:=round((100+50*greatest(0,r.seconds_per_question-extract(epoch from a.answered_at-a.served_at))/r.seconds_per_question)*(case when streak>=6 then 1.5 when streak>=3 then 1.2 else 1 end));
 else streak:=0;pts:=0;end if;
 best:=greatest(best,streak);total:=total+pts;elapsed:=elapsed+greatest(0,extract(epoch from a.answered_at-a.served_at));
 update public.attempts set points=pts where session_id=p_session and player_id=p_player and round_id=p_round and seq=a.seq;
 items:=items||jsonb_build_array(jsonb_build_object('seq',a.seq,'question_id',a.question_id,'chosen_option',a.option_id,'correct_option',a.correct_id,'explanation',a.explanation,'points',pts,'stem',a.snapshot->'stem','body',a.snapshot->'body','options',(select jsonb_agg(x - 'is_correct') from jsonb_array_elements(a.snapshot->'options') x)));
 end loop;
 update public.round_runs set submitted_at=clock_timestamp(),total_points=total,total_time=elapsed,best_streak=best where session_id=p_session and player_id=p_player and round_id=p_round;
 select rank into position from (select player_id,rank() over(order by sum(total_points) desc,sum(total_time)) from public.round_runs where session_id=p_session and submitted_at is not null group by player_id) ranks where player_id=p_player;
 result:=jsonb_build_object('round_id',p_round,'question_count',r.question_count,'seconds_per_question',r.seconds_per_question,'total_points',total,'best_streak',best,'questions',items,'cumulative_points',(select sum(total_points) from public.round_runs where session_id=p_session and player_id=p_player and submitted_at is not null),'leaderboard_position',position);
 update public.round_runs set debrief=result where session_id=p_session and player_id=p_player and round_id=p_round;
 return result;
end $$;


create or replace function public.finish_release(p_session uuid,p_round smallint,p_manual boolean default false) returns void
language plpgsql security definer set search_path=public as $$
declare cfg public.round_releases; s public.sessions; r record; hard_end boolean;
begin
 select * into s from public.sessions where id=p_session for update;
 select * into cfg from public.round_releases where session_id=p_session and round_id=p_round for update;
 if cfg.session_id is null or cfg.status<>'live' then return; end if;
 hard_end:=p_manual or s.status='closed' or clock_timestamp()>=least(cfg.closes_at,s.closes_at);
 for r in select player_id from public.round_runs where session_id=p_session and round_id=p_round and submitted_at is null order by player_id loop
  if hard_end then perform public.score_run(p_session,p_round,r.player_id,true,least(clock_timestamp(),cfg.closes_at,s.closes_at));
  else perform public.expire_run(p_session,p_round,r.player_id); end if;
 end loop;
 if hard_end or (clock_timestamp()>=cfg.admission_closes_at and not exists(select 1 from public.round_runs where session_id=p_session and round_id=p_round and submitted_at is null)) then
  update public.round_releases set status='ended',ended_at=least(clock_timestamp(),cfg.closes_at,s.closes_at) where session_id=p_session and round_id=p_round;
 end if;
end $$;
create or replace function public.submit_round(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r public.round_runs;
begin
 perform public.assert_member(p_session);
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid() for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is null then perform public.score_run(p_session,p_round,auth.uid()); end if;
 return jsonb_build_object('submitted',true,'round_id',p_round);
end $$;
create function public.my_result(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r public.round_runs;
begin
 perform public.assert_member(p_session);
 if not exists(select 1 from public.round_releases where session_id=p_session and round_id=p_round and status='ended') then raise exception 'debrief_not_released'; end if;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid();
 if r.submitted_at is null then raise exception 'result_unavailable'; end if;
 return r.debrief;
end $$;
create function public.student_state(p_session uuid) returns jsonb
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
 'results',(select coalesce(jsonb_agg(rr.round_id order by rr.round_id),'[]'::jsonb) from public.round_runs rr join public.round_releases rel using(session_id,round_id) where rr.session_id=p_session and rr.player_id=auth.uid() and rr.submitted_at is not null and rel.status='ended'));
end $$;
create or replace function public.capture_round_metrics()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- The scoring function has already updated every attempt's points.
  select
    count(*) filter (where a.points > 0),
    count(*) filter (where a.points = 0 and a.option_id is not null
      and public.answer_in_time(a.served_at,a.answered_at,new.seconds_per_question,new.deadline_grace_seconds)),
    count(*) filter (where a.option_id is null
      or not public.answer_in_time(a.served_at,a.answered_at,new.seconds_per_question,new.deadline_grace_seconds)),
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
        and public.answer_in_time(a.served_at,a.answered_at,r.seconds_per_question,r.deadline_grace_seconds)) as wrong_count,
      count(*) filter (where a.option_id is null
        or not public.answer_in_time(a.served_at,a.answered_at,r.seconds_per_question,r.deadline_grace_seconds)) as timeout_count,
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


revoke execute on function public.safe_table(jsonb),public.safe_body(jsonb),public.snapshot_question(bigint),public.assert_member(uuid),public.expire_run(uuid,smallint,uuid),public.student_state(uuid),public.my_result(uuid,smallint),public.submit_answer(uuid,smallint,smallint,uuid) from public,anon,authenticated;
grant execute on function public.student_state(uuid),public.my_result(uuid,smallint),public.submit_answer(uuid,smallint,smallint,uuid) to authenticated;

-- Bound authenticated code guessing. Return an error value instead of raising:
-- raising would roll back the rate counter along with the failed join.
create table public.join_limits (
 player_id uuid primary key references auth.users,
 window_start timestamptz not null,
 requests integer not null
);
alter table public.join_limits enable row level security;
revoke all on public.join_limits from public,anon,authenticated;
alter function public.join_session(text,text,text) rename to join_session_internal;
revoke execute on function public.join_session_internal(text,text,text) from public,anon,authenticated;
create function public.join_session(code text,nickname text,avatar_seed text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare uid uuid; limiter public.join_limits; result jsonb;
begin
 uid:=public.assert_domain();
 insert into public.join_limits values(uid,clock_timestamp(),1)
 on conflict(player_id) do update set
 requests=case when join_limits.window_start<clock_timestamp()-interval '1 minute' then 1 else join_limits.requests+1 end,
 window_start=case when join_limits.window_start<clock_timestamp()-interval '1 minute' then clock_timestamp() else join_limits.window_start end
 returning * into limiter;
 if limiter.requests>10 then return jsonb_build_object('error','Too many join attempts. Wait one minute.'); end if;
 begin
  result:=public.join_session_internal(code,nickname,avatar_seed);
 exception when others then
  return jsonb_build_object('error','Session unavailable. Check the code with your instructor.');
 end;
 return result;
end $$;
revoke execute on function public.join_session(text,text,text) from public,anon;
grant execute on function public.join_session(text,text,text) to authenticated;

-- Enrich historical debriefs without changing points or submission timestamps.
update public.round_runs r set debrief=jsonb_set(r.debrief,'{questions}',(
 select jsonb_agg(item || jsonb_build_object('stem',q.snapshot->'stem','body',q.snapshot->'body',
 'options',(select jsonb_agg(o - 'is_correct') from jsonb_array_elements(q.snapshot->'options') o)) order by (item->>'seq')::int)
 from jsonb_array_elements(r.debrief->'questions') item join public.release_questions q
 on q.session_id=r.session_id and q.round_id=r.round_id and q.question_id=(item->>'question_id')::bigint
)) where r.debrief is not null;
