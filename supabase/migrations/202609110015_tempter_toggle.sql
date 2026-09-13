-- Instructor choice: whether the good/evil Jerry tempters show during play.
-- Stored per release (one config fans out to all 9 rounds). When off, the server
-- simply omits tempt_options from the served payload, so nothing renders and the
-- pair is never even hinted at.
alter table public.round_releases add column tempters boolean not null default true;

-- start_rapid_fire gains a 4th arg. Drop the old 3-arg signature (its grant goes
-- with it) and recreate with p_tempters defaulted true so existing 3-arg callers
-- keep working.
drop function public.start_rapid_fire(uuid,smallint,smallint);
create function public.start_rapid_fire(p_session uuid,p_count smallint,p_seconds smallint,p_tempters boolean default true) returns void
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
 if exists(select 1 from public.rounds rd where (select count(*) from public.questions q where q.round_id=rd.id) < p_count) then
  raise exception 'insufficient_question_pool';
 end if;
 t:=clock_timestamp();
 for rid in select id from public.rounds order by id loop
  insert into public.round_releases(session_id,round_id,question_count,seconds_per_question,tempters,status,started_at,closes_at,admission_closes_at)
   values(p_session,rid,p_count,p_seconds,coalesce(p_tempters,true),'live',t,s.closes_at,s.closes_at)
   on conflict(session_id,round_id) do update set
    question_count=excluded.question_count,seconds_per_question=excluded.seconds_per_question,tempters=excluded.tempters,
    status='live',started_at=t,closes_at=excluded.closes_at,admission_closes_at=excluded.admission_closes_at;
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
revoke execute on function public.start_rapid_fire(uuid,smallint,smallint,boolean) from public,anon;
grant execute on function public.start_rapid_fire(uuid,smallint,smallint,boolean) to authenticated;

-- Only attach tempt_options when the release enabled the tempters. (Appending
-- conditionally keeps the key absent -- never null -- when disabled.)
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
 'options',opts,'served_at',a.served_at,'deadline',a.served_at+make_interval(secs=>cfg.seconds_per_question),'server_now',clock_timestamp(),'question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question)
 || case when cfg.tempters then jsonb_build_object('tempt_options',a.tempt_tokens) else '{}'::jsonb end;
end $$;

-- Surface the tempters setting to the host so the monitor can show it (and it
-- survives a refresh).
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
  'sections',(select jsonb_agg(name order by name) from public.sections),
  'session',case when s.id is not null then jsonb_build_object('id',s.id,'code',s.code,
    'status',case when s.closes_at is not null and clock_timestamp()>=s.closes_at then 'closed' else s.status end,'closes_at',s.closes_at) end,
  'config',case when cfg.session_id is not null then jsonb_build_object('question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,
    'duration_seconds',cfg.question_count*cfg.seconds_per_question,'tempters',cfg.tempters) end,
  'students_joined',(select count(*) from public.session_members where session_id=p_session),
  'students_done',(select count(*) from (
     select rr.player_id from public.round_runs rr where rr.session_id=p_session and rr.submitted_at is not null
     group by rr.player_id having count(*)=(select count(*) from public.rounds)) d),
  'server_now',clock_timestamp());
end $$;
