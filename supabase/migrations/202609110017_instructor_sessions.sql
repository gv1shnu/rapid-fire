-- Lets a signed-in instructor see every rapid fire they have run, so past
-- sessions (and their reports) stay reachable after the browser forgets the
-- active session id. Read-only and scoped to sessions the caller hosted.
create function public.instructor_sessions()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  uid := public.assert_domain();
  if not exists (select 1 from public.instructors where id = uid) then
    raise exception 'host_only';
  end if;
  return coalesce((
    select jsonb_agg(t.obj order by t.started_at desc nulls last)
    from (
      select
        jsonb_build_object(
          'id', s.id,
          'code', s.code,
          'section', s.section,
          'status', case
            when s.closes_at is not null and clock_timestamp() >= s.closes_at
            then 'closed' else s.status end,
          'started_at', s.started_at,
          'closes_at', s.closes_at,
          'question_count', cfg.question_count,
          'seconds_per_question', cfg.seconds_per_question,
          'students_joined',
            (select count(*) from public.session_members m where m.session_id = s.id),
          'students_done', (
            select count(*) from (
              select rr.player_id from public.round_runs rr
              where rr.session_id = s.id and rr.submitted_at is not null
              group by rr.player_id
              having count(*) = (select count(*) from public.rounds)
            ) d)
        ) as obj,
        s.started_at
      from public.sessions s
      left join lateral (
        select * from public.round_releases
        where session_id = s.id order by round_id limit 1
      ) cfg on true
      -- Only sessions that actually launched; drafts never opened are noise.
      where s.host = uid and s.started_at is not null
    ) t
  ), '[]'::jsonb);
end $$;
grant execute on function public.instructor_sessions() to authenticated;
