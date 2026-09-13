-- Freeze a correct + incorrect pair, including its random avatar assignment.
-- Only opaque tokens leave the server; neither position identifies correctness.
alter table public.attempts add column tempt_tokens uuid[];

create function public.pick_tempter_tokens(snap jsonb, ids bigint[], tokens uuid[])
returns uuid[] language sql volatile set search_path=public as $$
 select array_agg(tokens[array_position(ids,(o->>'id')::bigint)] order by random())
 from (
  (select o from jsonb_array_elements(snap->'options') o where (o->>'is_correct')::boolean limit 1)
  union all
  (select o from jsonb_array_elements(snap->'options') o where not (o->>'is_correct')::boolean order by random() limit 1)
 ) pair;
$$;
revoke execute on function public.pick_tempter_tokens(jsonb,bigint[],uuid[]) from public,anon,authenticated;

-- Existing runs retain their option tokens and receive a frozen pair as well.
update public.attempts a
set tempt_tokens=public.pick_tempter_tokens(q.snapshot,a.option_order,a.option_tokens)
from public.release_questions q
where q.session_id=a.session_id and q.round_id=a.round_id and q.question_id=a.question_id;
alter table public.attempts alter column tempt_tokens set not null;
alter table public.attempts add constraint two_tempter_tokens check (
 array_ndims(tempt_tokens)=1 and array_lower(tempt_tokens,1)=1 and cardinality(tempt_tokens)=2
 and array_position(tempt_tokens,null) is null
 and tempt_tokens[1]<>tempt_tokens[2] and tempt_tokens <@ option_tokens
);

-- CREATE OR REPLACE preserves the existing RPC grants and self-paced gates.
create or replace function public.start_round(p_session uuid,p_round smallint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.sessions; cfg public.round_releases; q record; n integer:=0; ids bigint[]; tokens uuid[]; r public.round_runs;
begin
 s:=public.assert_live(p_session); cfg:=public.assert_release(p_session,p_round);
 if p_round is null or p_round<1 or p_round>9 then raise exception 'round_out_of_order'; end if;
 if exists(select 1 from public.rounds rd where rd.id<p_round and not exists(
   select 1 from public.round_runs rr where rr.session_id=p_session and rr.player_id=auth.uid() and rr.round_id=rd.id and rr.submitted_at is not null))
 then raise exception 'round_out_of_order'; end if;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid();
 if r.session_id is null and clock_timestamp()>=cfg.admission_closes_at then raise exception 'admission_closed'; end if;
 insert into public.round_runs(session_id,player_id,round_id,question_count,seconds_per_question) values(p_session,auth.uid(),p_round,cfg.question_count,cfg.seconds_per_question) on conflict do nothing;
 select * into r from public.round_runs where session_id=p_session and round_id=p_round and player_id=auth.uid() for update;
 if r.submitted_at is not null then return jsonb_build_object('round_complete',true,'round_id',p_round,'server_now',clock_timestamp()); end if;
 if not exists(select 1 from public.attempts where session_id=p_session and round_id=p_round and player_id=auth.uid()) then
  for q in select * from public.release_questions where session_id=p_session and round_id=p_round order by leg,random() loop
   n:=n+1;
   select array_agg((o->>'id')::bigint order by case when (q.snapshot->>'lock_order')::boolean then (o->>'id')::double precision else random() end) into ids from jsonb_array_elements(q.snapshot->'options') o;
   tokens:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
   insert into public.attempts(session_id,player_id,round_id,seq,question_id,option_order,option_tokens,tempt_tokens)
   values(p_session,auth.uid(),p_round,n,q.question_id,ids,tokens,public.pick_tempter_tokens(q.snapshot,ids,tokens));
  end loop;
  if n<>cfg.question_count then raise exception 'insufficient_question_pool'; end if;
 end if;
 return public.serve_pending(p_session,p_round);
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
 'options',opts,'tempt_options',a.tempt_tokens,'served_at',a.served_at,'deadline',a.served_at+make_interval(secs=>cfg.seconds_per_question),'server_now',clock_timestamp(),'question_count',cfg.question_count,'seconds_per_question',cfg.seconds_per_question);
end $$;
