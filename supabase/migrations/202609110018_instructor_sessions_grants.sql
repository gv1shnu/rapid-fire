-- Lock down instructor_sessions() to match the security-definer convention used
-- by the report functions: strip the default PUBLIC execute so anonymous
-- callers cannot even enter the function, then allow only authenticated users.
revoke execute on function public.instructor_sessions()
  from public, anon, authenticated;
grant execute on function public.instructor_sessions() to authenticated;
