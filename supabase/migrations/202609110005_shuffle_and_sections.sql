-- Fixed section labels A-E for the instructor dropdown, independent of the
-- student roster. And a same-content-per-release draw: every student in one
-- release (session + round) gets the SAME set of questions, but each student
-- gets them in their own order, so no two students sit on the same question at
-- the same moment. Option order is already shuffled per student (option_order).

create table public.sections (name text primary key);
insert into public.sections values ('A'), ('B'), ('C'), ('D'), ('E');
alter table public.sections enable row level security;
revoke all on public.sections from public, anon, authenticated;

-- open_session now accepts any A-E section label; it no longer requires the
-- section to exist in the roster.
create or replace function public.open_session(p_section text,p_closes_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.sessions; c text;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if p_closes_at is null or p_closes_at<=clock_timestamp() or p_closes_at>clock_timestamp()+interval '3 hours' then raise exception 'invalid_close_time'; end if;
 if not exists(select 1 from public.sections where name=p_section) then raise exception 'unknown_section'; end if;
 loop
 select string_agg(chr(65+floor(random()*26)::int),'') into c from generate_series(1,6);
 begin
 insert into public.sessions(code,section,host,status,closes_at) values(c,p_section,uid,'lobby',p_closes_at) returning * into s;
 exit;
 exception when unique_violation then null;end;
 end loop;
 perform realtime.send(jsonb_build_object('session_id',s.id),'session_opened','session:'||s.id,true);
 return jsonb_build_object('session_id',s.id,'code',s.code,'status',s.status,'closes_at',s.closes_at);
end $$;

-- The section dropdown is the fixed A-E list.
create or replace function public.instructor_state(p_session uuid default null)
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
  return jsonb_build_object('rounds',catalogue,'sections',(select jsonb_agg(name order by name) from public.sections),
    'session',case when s.id is not null then jsonb_build_object('id',s.id,'code',s.code,'status',s.status,'current_round',s.current_round,'closes_at',s.closes_at) end,
    'release',release,'server_now',clock_timestamp());
end $$;

-- Same content per release, different order per student. The question SELECTION
-- is deterministic in the release (md5 over session+round+id, identical for
-- every student), so all students face the same set; the final ORDER uses
-- random() so each student's sequence differs. Options stay per-student shuffled.
create or replace function public.start_round(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; q record; n integer:=0; ids bigint[]; cfg public.round_releases; salt text;
begin
 s:=public.assert_live(p_session);
 cfg:=public.assert_release(p_session,p_round);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question) values(p_session,auth.uid(),p_round,cfg.question_count,cfg.seconds_per_question) on conflict do nothing;
 perform public.lock_round(p_session,p_round);
 if exists(select 1 from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round) then return public.serve_pending(p_session,p_round); end if;
 if (select count(*) from public.questions where round_id=p_round)<cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 salt:=p_session::text||':'||p_round::text||':';
 for q in
 with ranked as (
   select id,lock_order,difficulty,row_number() over(partition by difficulty order by md5(salt||id::text)) rn
   from public.questions where round_id=p_round
 ), drawn as (
   select *,case when difficulty='easy' then 1 when difficulty='medium' and rn<=10 then 2 else 3 end leg,
     row_number() over(order by md5(salt||id::text)) rn_all
   from ranked
   where cfg.question_count<>30 or (difficulty='easy' and rn<=10)
     or (difficulty='medium' and rn<=14) or (difficulty='hard' and rn<=6)
 ), selected as (
   select * from drawn where cfg.question_count=30 or rn_all<=cfg.question_count
 )
 select * from selected order by case when cfg.question_count<>30 then random() else leg end, random()
 loop
 n:=n+1;
 select array_agg(id order by case when q.lock_order then id::double precision else random() end) into ids from public.options where question_id=q.id;
 insert into public.attempts(session_id,player_id,round_id,seq,question_id,option_order) values(p_session,auth.uid(),p_round,n,q.id,ids);
 end loop;
 if n<>cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 return public.serve_pending(p_session,p_round);
end $$;
