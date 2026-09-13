-- The section dropdown is the fixed A-E list from public.sections (migration
-- 005), independent of any roster. Students are never pre-loaded; they populate
-- public.players / session_members on their first join. Migration 012 mistakenly
-- read sections from the roster (which is empty in production, so the dropdown
-- came up blank) -- restore the fixed A-E source.
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
    'duration_seconds',cfg.question_count*cfg.seconds_per_question) end,
  'students_joined',(select count(*) from public.session_members where session_id=p_session),
  'students_done',(select count(*) from (
     select rr.player_id from public.round_runs rr where rr.session_id=p_session and rr.submitted_at is not null
     group by rr.player_id having count(*)=(select count(*) from public.rounds)) d),
  'server_now',clock_timestamp());
end $$;
