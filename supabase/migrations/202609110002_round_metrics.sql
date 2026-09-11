-- Capture metrics atomically with scoring. Browser roles retain no table access.
alter table public.attempts add constraint nonnegative_points check (points >= 0);
alter table public.round_runs add constraint nonnegative_total_points check (total_points >= 0);
alter table public.round_runs
  add column correct_count smallint,
  add column wrong_count smallint,
  add column timeout_count smallint,
  add column under_half_count smallint,
  add column average_answer_seconds numeric generated always as
    (case when submitted_at is not null then total_time / 30 end) stored,
  add column accuracy_percent numeric generated always as
    (correct_count * 100.0 / 30) stored;

create function public.capture_round_metrics()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- The scoring function has already updated every attempt's points.
  select
    count(*) filter (where a.points > 0),
    count(*) filter (where a.points = 0 and a.option_id is not null
      and a.answered_at <= a.served_at + interval '13 seconds'),
    count(*) filter (where a.option_id is null
      or a.answered_at > a.served_at + interval '13 seconds'),
    count(*) filter (where a.option_id is not null
      and a.answered_at >= a.served_at
      and a.answered_at < a.served_at + interval '6 seconds')
  into new.correct_count, new.wrong_count, new.timeout_count, new.under_half_count
  from public.attempts a
  where a.session_id = new.session_id and a.player_id = new.player_id
    and a.round_id = new.round_id and a.answered_at is not null;
  if new.correct_count + new.wrong_count + new.timeout_count <> 30 then
    raise exception 'round_incomplete';
  end if;
  return new;
end;
$$;

create trigger record_round_metrics
before update of submitted_at on public.round_runs
for each row when (new.submitted_at is not null and old.correct_count is null)
execute function public.capture_round_metrics();

-- Existing submissions are backfilled once using their persisted scores.
update public.round_runs set submitted_at = submitted_at
where submitted_at is not null and correct_count is null;

alter table public.round_runs add constraint complete_round_metrics check (
  (submitted_at is null and correct_count is null and wrong_count is null
    and timeout_count is null and under_half_count is null)
  or
  (submitted_at is not null and correct_count is not null and wrong_count is not null
    and timeout_count is not null and under_half_count is not null
    and correct_count between 0 and 30 and wrong_count between 0 and 30
    and timeout_count between 0 and 30
    and correct_count + wrong_count + timeout_count = 30
    and under_half_count between 0 and correct_count + wrong_count)
);

-- Reports are an instructor administrative operation, intentionally available
-- after closure. They do not use the live-only student game gate.
create function public.round_report(p_session uuid, p_round smallint)
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
  select * into s from public.sessions where id = p_session for share;
  if s.host is distinct from uid
    or not exists (select 1 from public.instructors where id = uid) then
    raise exception 'host_only';
  end if;
  if s.status <> 'closed' and (s.closes_at is null or clock_timestamp() < s.closes_at) then
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
        and a.answered_at <= a.served_at + interval '13 seconds') as wrong_count,
      count(*) filter (where a.option_id is null
        or a.answered_at > a.served_at + interval '13 seconds') as timeout_count,
      avg(greatest(0, extract(epoch from a.answered_at - a.served_at))) as average_answer_seconds,
      100.0 * count(*) filter (where a.points > 0) / count(*) as accuracy_percent,
      count(*) filter (where a.option_id is not null
        and a.answered_at >= a.served_at
        and a.answered_at < a.served_at + interval '6 seconds') as students_under_half_time
    from public.attempts a join public.round_runs r
      on r.session_id = a.session_id and r.player_id = a.player_id and r.round_id = a.round_id
    where a.session_id = p_session and a.round_id = p_round and r.submitted_at is not null
    group by a.question_id
  ) q;

  return jsonb_build_object('session_id', p_session, 'round_id', p_round,
    'half_time_seconds', 6, 'summary', summary, 'students', students, 'questions', questions);
end;
$$;

revoke execute on function public.capture_round_metrics() from public, anon, authenticated;
revoke execute on function public.round_report(uuid, smallint) from public, anon, authenticated;
grant execute on function public.round_report(uuid, smallint) to authenticated;
