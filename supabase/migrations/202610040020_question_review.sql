-- Review and edit the drawn questions before going live.
--
-- prepare_rapid_fire draws the questions into draft releases (status 'draft'),
-- so the host can read every question with its answer, swap one for another
-- from the same lecture pool, or edit its wording, options, correct answer and
-- explanation. Edits change only this session's frozen snapshot, never the
-- shared bank. start_rapid_fire then promotes the draft unchanged; the join
-- link is shown only once it is live.
--
-- Scoring, tempters and debriefs already read release_questions snapshots, so
-- edited questions are graded exactly as reviewed.

alter table public.round_releases add column prepared_at timestamptz;

-- Host-owned, still-unstarted session; returns it locked.
create function public.assert_draft_host(p_session uuid) returns public.sessions
language plpgsql security definer set search_path=public as $$
declare uid uuid; s public.sessions;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for update;
 if s.id is null or s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if s.status='closed' or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if s.status='live' or exists(select 1 from public.round_releases where session_id=p_session and status<>'draft') then raise exception 'already_started'; end if;
 return s;
end $$;

-- Everything the host needs to review the draft, answers included.
create function public.draft_review(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare cfg public.round_releases;
begin
 perform public.assert_draft_host(p_session);
 select * into cfg from public.round_releases where session_id=p_session order by round_id limit 1;
 if cfg.session_id is null then raise exception 'no_draft'; end if;
 return jsonb_build_object(
  'config',jsonb_build_object('question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,'tempters',cfg.tempters),
  'rounds',(select jsonb_agg(jsonb_build_object('id',rd.id,'title',rd.title,
     'available',(select count(*) from public.questions q where q.round_id=rd.id),
     'questions',(select coalesce(jsonb_agg(jsonb_build_object(
        'question_id',rq.question_id,'stem',rq.snapshot->'stem','display_type',rq.snapshot->'display_type',
        'body',rq.snapshot->'body','explanation',rq.snapshot->'explanation','options',rq.snapshot->'options',
        'edited',rq.snapshot is distinct from public.snapshot_question(rq.question_id)) order by rq.question_id),'[]'::jsonb)
      from public.release_questions rq where rq.session_id=p_session and rq.round_id=rd.id)) order by rd.id)
   from public.rounds rd));
end $$;

-- Draw (or keep) the draft. Changing the count redraws; otherwise reviewed and
-- edited questions survive a settings change.
create function public.prepare_rapid_fire(p_session uuid,p_count smallint,p_seconds smallint,p_tempters boolean default true) returns jsonb
language plpgsql security definer set search_path=public as $$
declare rid smallint; t timestamptz:=clock_timestamp(); redraw boolean;
begin
 perform public.assert_draft_host(p_session);
 if p_count is null or p_count<1 or p_count>300 then raise exception 'invalid_question_count'; end if;
 if p_seconds is null or p_seconds<1 or p_seconds>120 then raise exception 'invalid_seconds'; end if;
 if exists(select 1 from public.rounds rd where (select count(*) from public.questions q where q.round_id=rd.id) < p_count) then
  raise exception 'insufficient_question_pool';
 end if;
 redraw:=not exists(select 1 from public.round_releases where session_id=p_session)
  or exists(select 1 from public.round_releases where session_id=p_session and question_count<>p_count);
 if redraw then delete from public.release_questions where session_id=p_session; end if;
 for rid in select id from public.rounds order by id loop
  insert into public.round_releases(session_id,round_id,question_count,seconds_per_question,tempters,status,prepared_at)
   values(p_session,rid,p_count,p_seconds,coalesce(p_tempters,true),'draft',t)
   on conflict(session_id,round_id) do update set
    question_count=excluded.question_count,seconds_per_question=excluded.seconds_per_question,
    tempters=excluded.tempters,prepared_at=coalesce(public.round_releases.prepared_at,excluded.prepared_at);
  if redraw then
   insert into public.release_questions(session_id,round_id,question_id,leg,snapshot)
   select p_session,rid,id,1,public.snapshot_question(id)
   from (select id from public.questions where round_id=rid order by random() limit p_count) x;
  end if;
 end loop;
 return public.draft_review(p_session);
end $$;

-- Replace one drafted question with a random unused one from the same lecture.
create function public.swap_draft_question(p_session uuid,p_round smallint,p_question bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare replacement bigint;
begin
 perform public.assert_draft_host(p_session);
 if not exists(select 1 from public.release_questions where session_id=p_session and round_id=p_round and question_id=p_question) then
  raise exception 'not_in_draft';
 end if;
 select q.id into replacement from public.questions q where q.round_id=p_round and not exists(
  select 1 from public.release_questions rq where rq.session_id=p_session and rq.round_id=p_round and rq.question_id=q.id)
 order by random() limit 1;
 if replacement is null then raise exception 'no_replacement'; end if;
 delete from public.release_questions where session_id=p_session and round_id=p_round and question_id=p_question;
 insert into public.release_questions(session_id,round_id,question_id,leg,snapshot)
  values(p_session,p_round,replacement,1,public.snapshot_question(replacement));
 return public.draft_review(p_session);
end $$;

-- Edit this session's copy of a drafted question. p_options is
-- [{"id":<option id>,"text":"…"}] covering exactly the question's options;
-- p_correct names the single correct option. Code and table bodies are kept.
create function public.edit_draft_question(p_session uuid,p_round smallint,p_question bigint,
 p_stem text,p_options jsonb,p_correct bigint,p_explanation text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare snap jsonb; ids bigint[]; given bigint[]; opts jsonb;
begin
 perform public.assert_draft_host(p_session);
 select snapshot into snap from public.release_questions where session_id=p_session and round_id=p_round and question_id=p_question for update;
 if snap is null then raise exception 'not_in_draft'; end if;
 p_stem:=btrim(coalesce(p_stem,'')); p_explanation:=btrim(coalesce(p_explanation,''));
 if length(p_stem) not between 1 and 500 then raise exception 'invalid_stem'; end if;
 if length(p_explanation) not between 1 and 1000 then raise exception 'invalid_explanation'; end if;
 if jsonb_typeof(p_options) is distinct from 'array' then raise exception 'invalid_options'; end if;
 select array_agg((o->>'id')::bigint order by (o->>'id')::bigint) into ids from jsonb_array_elements(snap->'options') o;
 select array_agg((o->>'id')::bigint order by (o->>'id')::bigint) into given from jsonb_array_elements(p_options) o;
 if given is distinct from ids then raise exception 'invalid_options'; end if;
 if exists(select 1 from jsonb_array_elements(p_options) o
   where jsonb_typeof(o->'text') is distinct from 'string' or length(btrim(o->>'text')) not between 1 and 300) then
  raise exception 'invalid_option_text';
 end if;
 if p_correct is null or not (p_correct = any(ids)) then raise exception 'invalid_correct_option'; end if;
 select jsonb_agg(jsonb_build_object(
   'id',(o->>'id')::bigint,
   'body',public.safe_body(coalesce(o->'body','{}'::jsonb)||jsonb_build_object('text',(select btrim(e->>'text') from jsonb_array_elements(p_options) e where (e->>'id')::bigint=(o->>'id')::bigint))),
   'is_correct',(o->>'id')::bigint=p_correct) order by (o->>'id')::bigint)
 into opts from jsonb_array_elements(snap->'options') o;
 update public.release_questions
  set snapshot=snap||jsonb_build_object('stem',p_stem,'explanation',p_explanation,'options',opts)
  where session_id=p_session and round_id=p_round and question_id=p_question;
 return public.draft_review(p_session);
end $$;

-- Discard this session's edits to one question.
create function public.reset_draft_question(p_session uuid,p_round smallint,p_question bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
 perform public.assert_draft_host(p_session);
 update public.release_questions set snapshot=public.snapshot_question(p_question)
  where session_id=p_session and round_id=p_round and question_id=p_question;
 if not found then raise exception 'not_in_draft'; end if;
 return public.draft_review(p_session);
end $$;

-- Promote a reviewed draft as-is, or draw fresh when there is none (or its
-- count no longer matches). Time spent reviewing does not shorten the sitting:
-- the session cutoff moves forward by it, within the three-hour cap.
create or replace function public.start_rapid_fire(p_session uuid,p_count smallint,p_seconds smallint,p_tempters boolean default true) returns void
language plpgsql security definer set search_path=public as $$
declare uid uuid; s public.sessions; t timestamptz; rid smallint; drafted timestamptz; keep boolean;
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
 keep:=(select count(*) from public.round_releases where session_id=p_session and status='draft' and question_count=p_count)=(select count(*) from public.rounds);
 if keep then
  select min(prepared_at) into drafted from public.round_releases where session_id=p_session;
  if drafted is not null then
   s.closes_at:=least(s.closes_at+(t-drafted),t+interval '3 hours');
   update public.sessions set closes_at=s.closes_at where id=p_session;
  end if;
 else
  delete from public.release_questions where session_id=p_session;
 end if;
 for rid in select id from public.rounds order by id loop
  insert into public.round_releases(session_id,round_id,question_count,seconds_per_question,tempters,status,started_at,closes_at,admission_closes_at)
   values(p_session,rid,p_count,p_seconds,coalesce(p_tempters,true),'live',t,s.closes_at,s.closes_at)
   on conflict(session_id,round_id) do update set
    question_count=excluded.question_count,seconds_per_question=excluded.seconds_per_question,tempters=excluded.tempters,
    status='live',started_at=t,closes_at=excluded.closes_at,admission_closes_at=excluded.admission_closes_at;
  if not keep then
   insert into public.release_questions(session_id,round_id,question_id,leg,snapshot)
   select p_session,rid,id,1,public.snapshot_question(id)
   from (select id from public.questions where round_id=rid order by random() limit p_count) x;
  end if;
  if (select count(*) from public.release_questions where session_id=p_session and round_id=rid)<>p_count then
   raise exception 'insufficient_question_pool';
  end if;
 end loop;
 update public.sessions set status='live',current_round=1,started_at=coalesce(started_at,t) where id=p_session;
 perform realtime.send(jsonb_build_object('started',true),'rapid_fire_started','session:'||p_session,true);
end $$;

-- A draft is not a started rapid fire: report it separately so the control
-- room keeps showing setup (and never the join link) until it goes live.
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
  'config',case when cfg.session_id is not null and cfg.status<>'draft' then jsonb_build_object('question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,
    'duration_seconds',cfg.question_count*cfg.seconds_per_question,'tempters',cfg.tempters) end,
  'draft',case when cfg.status='draft' then jsonb_build_object('question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question,
    'tempters',cfg.tempters) end,
  'students_joined',(select count(*) from public.session_members where session_id=p_session),
  'students_done',(select count(*) from (
     select rr.player_id from public.round_runs rr where rr.session_id=p_session and rr.submitted_at is not null
     group by rr.player_id having count(*)=(select count(*) from public.rounds)) d),
  'server_now',clock_timestamp());
end $$;

revoke execute on function public.assert_draft_host(uuid) from public,anon,authenticated;
revoke execute on function public.draft_review(uuid),
 public.prepare_rapid_fire(uuid,smallint,smallint,boolean),
 public.swap_draft_question(uuid,smallint,bigint),
 public.edit_draft_question(uuid,smallint,bigint,text,jsonb,bigint,text),
 public.reset_draft_question(uuid,smallint,bigint) from public,anon;
grant execute on function public.draft_review(uuid),
 public.prepare_rapid_fire(uuid,smallint,smallint,boolean),
 public.swap_draft_question(uuid,smallint,bigint),
 public.edit_draft_question(uuid,smallint,bigint,text,jsonb,bigint,text),
 public.reset_draft_question(uuid,smallint,bigint) to authenticated;
