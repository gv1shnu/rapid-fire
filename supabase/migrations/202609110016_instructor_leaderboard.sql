-- Post-close, host-only class analytics. Student standings remain separate.
create function public.session_report(p_session uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare uid uuid; s public.sessions; n integer; students jsonb; summary jsonb;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for update;
 if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then
  raise exception 'host_only';
 end if;
 if s.status<>'closed' and (s.closes_at is null or clock_timestamp()<s.closes_at) then
  raise exception 'report_available_after_session';
 end if;
 -- The cutoff may have elapsed without any student or host polling since then.
 perform public.finalize_session(p_session);
 select question_count into n from public.round_releases where session_id=p_session order by round_id limit 1;

 -- NOTE: Migration 003 already corrected the original /30 generated columns.
 -- Derive session ratios explicitly from the submitted releases' question counts;
 -- with the shared configuration this denominator is N * rounds_completed.
 with totals as (
  select r.player_id, sum(r.total_points) total_points, max(r.best_streak) best_streak,
   count(*) rounds_completed, sum(r.correct_count) correct_count,
   sum(r.wrong_count) wrong_count, sum(r.timeout_count) timeout_count,
   sum(r.under_half_count) answers_under_half_time, sum(r.total_time) total_answer_seconds,
   sum(q.question_count) total_questions
  from public.round_runs r join public.round_releases q using(session_id,round_id)
  where r.session_id=p_session and r.submitted_at is not null group by r.player_id
 ), board as (
  select rank() over(order by t.total_points desc,t.total_answer_seconds) rank,
   t.player_id,p.nickname,
   coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),
     nullif(trim(u.raw_user_meta_data->>'name'),''),p.nickname) name,
   t.total_points,t.best_streak,t.rounds_completed,t.correct_count,t.wrong_count,t.timeout_count,
   t.answers_under_half_time,t.total_answer_seconds,
   t.correct_count*100.0/nullif(t.total_questions,0) accuracy_percent,
   t.total_answer_seconds/nullif(t.total_questions,0) average_answer_seconds
  from totals t join public.players p on p.id=t.player_id left join auth.users u on u.id=p.id
 )
 select coalesce(jsonb_agg(to_jsonb(b) order by b.rank,b.player_id),'[]'::jsonb),
  jsonb_build_object(
   'submitted_students',count(*),
   'students_joined',(select count(*) from public.session_members where session_id=p_session),
   'average_score',avg(total_points),'average_correct_count',avg(correct_count),
   'average_wrong_count',avg(wrong_count),'average_timeout_count',avg(timeout_count),
   'average_total_answer_seconds',avg(total_answer_seconds),
   'average_answer_seconds',avg(average_answer_seconds),'average_accuracy_percent',avg(accuracy_percent),
   'students_with_under_half_answers',count(*) filter(where answers_under_half_time>0),
   'answers_under_half_time',coalesce(sum(answers_under_half_time),0)
  ) into students,summary from board b;
 return jsonb_build_object('session_id',p_session,'question_count',n,'summary',summary,'students',students);
end $$;
revoke execute on function public.session_report(uuid) from public,anon,authenticated;
grant execute on function public.session_report(uuid) to authenticated;
