-- All browser access is through the explicitly granted RPCs at the end.
revoke create on schema public from public, anon, authenticated;
create table public.allowed_domains (domain text primary key check (domain = lower(domain)));
create table public.roster (email text primary key check (email = lower(email)), section text not null);
create table public.instructors (id uuid primary key references auth.users);
create table public.rounds (id smallint primary key check (id between 1 and 9), lecture text not null, theme_key text not null unique, title text not null);
create table public.questions (
 id bigint generated always as identity primary key, round_id smallint not null references public.rounds,
 display_type text not null check(display_type in ('concept','code_read','predict_result','reverse_query','spot_bug','fill_blank','diagram','visual')),
 difficulty text not null check(difficulty in ('easy','medium','hard')), stem text not null,
 body jsonb, explanation text not null, lock_order boolean not null default false
);
create index questions_draw on public.questions(round_id, difficulty);
create table public.options (
 id bigint generated always as identity primary key, question_id bigint not null references public.questions on delete cascade,
 body jsonb not null, is_correct boolean not null, misconception text,
 check ((is_correct and misconception is null) or (not is_correct and misconception is not null))
);
create unique index one_correct_option on public.options(question_id) where is_correct;
create index options_question on public.options(question_id);
create table public.players (id uuid primary key references auth.users, section text not null, nickname text not null check(length(nickname) between 1 and 30), avatar_seed text not null check(length(avatar_seed) between 1 and 64));
create table public.sessions (
 id uuid primary key default gen_random_uuid(), code text not null unique check(code ~ '^[A-Z]{6}$'), section text not null,
 host uuid not null references auth.users, status text not null default 'closed' check(status in ('closed','lobby','live')),
 current_round smallint references public.rounds, started_at timestamptz, closes_at timestamptz
);
create table public.round_runs (
 session_id uuid not null references public.sessions, player_id uuid not null references public.players,
 round_id smallint not null references public.rounds, submitted_at timestamptz, total_points integer not null default 0,
 total_time numeric not null default 0, best_streak smallint not null default 0, debrief jsonb,
 primary key(session_id,player_id,round_id)
);
create table public.attempts (
 session_id uuid not null, player_id uuid not null, round_id smallint not null,
 seq smallint not null check(seq between 1 and 30), question_id bigint not null references public.questions,
 option_order bigint[] not null check(cardinality(option_order)=4),
 -- Unseen questions have no clock. A retry must never reset served_at.
 served_at timestamptz, answered_at timestamptz, option_id bigint references public.options,
 points smallint not null default 0, primary key(session_id,player_id,round_id,seq),
 unique(session_id,player_id,round_id,question_id),
 foreign key(session_id,player_id,round_id) references public.round_runs,
 check(answered_at is null or served_at is not null)
);
create index runs_leaderboard on public.round_runs(session_id,player_id) where submitted_at is not null;

-- Deferred so authors can insert a question and its options in one transaction.
create function public.validate_mcq() returns trigger language plpgsql security definer set search_path = public as $$
declare qid bigint; n integer; c integer;
begin
 if tg_table_name = 'questions' then qid := coalesce(new.id,old.id);
 else qid := coalesce(new.question_id,old.question_id); end if;
 if exists(select 1 from public.questions where id=qid) then
  select count(*),count(*) filter(where is_correct) into n,c from public.options where question_id=qid;
  if n<>4 or c<>1 then raise exception 'question_requires_four_options_one_correct'; end if;
 end if;
 if tg_op='UPDATE' and tg_table_name='options' then
 if old.question_id<>new.question_id then
  if exists(select 1 from public.questions where id=old.question_id) and
   (select count(*)<>4 or count(*) filter(where is_correct)<>1 from public.options where question_id=old.question_id)
  then raise exception 'question_requires_four_options_one_correct'; end if;
 end if;
 end if;
 return null;
end $$;
create constraint trigger question_shape after insert or update on public.questions deferrable initially deferred for each row execute function public.validate_mcq();
create constraint trigger option_shape after insert or update or delete on public.options deferrable initially deferred for each row execute function public.validate_mcq();

create function public.assert_domain() returns uuid language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
 select * into u from auth.users where id=auth.uid();
 if u.id is null or u.email_confirmed_at is null or u.raw_app_meta_data->>'provider' is distinct from 'google'
 or not exists(select 1 from public.allowed_domains where domain=lower(split_part(u.email,'@',2)))
 then raise exception 'domain_not_allowed'; end if;
 return u.id;
end $$;
create function public.before_user_created(event jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
 if event->'user'->'app_metadata'->>'provider' is distinct from 'google' or
 not exists(select 1 from public.allowed_domains where domain=lower(split_part(event->'user'->>'email','@',2))) then
 return jsonb_build_object('error',jsonb_build_object('http_code',403,'message','Use your college Google account.'));
 end if;
 return '{}'::jsonb;
end $$;
create function public.assert_live(p_session uuid) returns public.sessions language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for share;
 if s.id is null or s.status<>'live' or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if not exists(select 1 from public.players p join public.roster r on r.section=p.section
 join auth.users u on lower(u.email)=r.email and u.id=p.id
 where p.id=uid and p.section=s.section) then raise exception 'not_in_this_section'; end if;
 return s;
end $$;
create function public.join_session(code text,nickname text,avatar_seed text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid; sec text;
begin
 uid:=public.assert_domain();
 select r.section into sec from public.roster r join auth.users u on lower(u.email)=r.email where u.id=uid;
 select * into s from public.sessions where sessions.code=upper(trim(join_session.code)) for share;
 if s.id is null or s.status not in ('lobby','live') or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if sec is distinct from s.section then raise exception 'not_in_this_section'; end if;
 insert into public.players values(uid,sec,trim(nickname),avatar_seed) on conflict(id) do update set nickname=excluded.nickname,avatar_seed=excluded.avatar_seed,section=excluded.section;
 return jsonb_build_object('session_id',s.id,'status',s.status,'current_round',s.current_round,'closes_at',s.closes_at);
end $$;

-- Private helper: only the pending question, with an explicit payload allowlist.
create function public.serve_pending(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; q public.questions; opts jsonb;
begin
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and answered_at is null order by seq limit 1 for update;
 if a.seq is null then return jsonb_build_object('round_complete',true); end if;
 if a.served_at is null then
 update public.attempts set served_at=clock_timestamp() where session_id=p_session and player_id=auth.uid() and round_id=p_round and seq=a.seq returning * into a;
 end if;
 select * into q from public.questions where id=a.question_id;
 select jsonb_agg(jsonb_build_object('id',o.id,'body',jsonb_strip_nulls(jsonb_build_object('text',o.body->'text','table_json',o.body->'table_json'))) order by x.ord) into opts
 from unnest(a.option_order) with ordinality x(id,ord) join public.options o on o.id=x.id;
 return jsonb_build_object('seq',a.seq,'question_id',q.id,'display_type',q.display_type,'stem',q.stem,
 'body',jsonb_strip_nulls(jsonb_build_object('code_html',q.body->'code_html','table_json',q.body->'table_json','image_ref',q.body->'image_ref')),
 'options',opts,'served_at',a.served_at,'deadline',a.served_at+interval '12 seconds','server_now',clock_timestamp());
end $$;
create function public.lock_round(p_session uuid,p_round smallint) returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; r public.round_runs;
begin
 s:=public.assert_live(p_session);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 select * into r from public.round_runs where session_id=p_session and player_id=auth.uid() and round_id=p_round for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is not null then raise exception 'round_already_submitted'; end if;
end $$;
create function public.start_round(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; q record; n integer:=0; ids bigint[];
begin
 s:=public.assert_live(p_session);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 insert into public.round_runs(session_id,player_id,round_id) values(p_session,auth.uid(),p_round) on conflict do nothing;
 perform public.lock_round(p_session,p_round);
 if exists(select 1 from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round) then return public.serve_pending(p_session,p_round); end if;
 if (select count(*) from public.questions where round_id=p_round and difficulty='easy')<10 or
 (select count(*) from public.questions where round_id=p_round and difficulty='medium')<14 or
 (select count(*) from public.questions where round_id=p_round and difficulty='hard')<6 then raise exception 'insufficient_question_pool'; end if;
 for q in
 with ranked as (select id,lock_order,difficulty,row_number() over(partition by difficulty order by random()) rn from public.questions where round_id=p_round),
 drawn as (select *,case when difficulty='easy' then 1 when difficulty='medium' and rn<=10 then 2 else 3 end leg from ranked where (difficulty='easy' and rn<=10) or (difficulty='medium' and rn<=14) or (difficulty='hard' and rn<=6))
 select * from drawn order by leg,random()
 loop
 n:=n+1;
 select array_agg(id order by case when q.lock_order then id::double precision else random() end) into ids from public.options where question_id=q.id;
 insert into public.attempts(session_id,player_id,round_id,seq,question_id,option_order) values(p_session,auth.uid(),p_round,n,q.id,ids);
 end loop;
 return public.serve_pending(p_session,p_round);
end $$;
create function public.next_question(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
begin
 perform public.lock_round(p_session,p_round);
 return public.serve_pending(p_session,p_round);
end $$;
create function public.submit_answer(p_session uuid,p_round smallint,seq smallint,option_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; t timestamptz;
begin
 perform public.lock_round(p_session,p_round);
 select * into a from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and attempts.seq=submit_answer.seq;
 if a.seq is null or a.served_at is null then raise exception 'question_not_served'; end if;
 -- Retries are immutable and return the same pending question without resetting its clock.
 if a.answered_at is not null then return public.serve_pending(p_session,p_round); end if;
 if option_id is not null and not(option_id=any(a.option_order)) then raise exception 'invalid_option'; end if;
 t:=clock_timestamp();
 if option_id is null and t<a.served_at+interval '12 seconds' then raise exception 'answer_required'; end if;
 update public.attempts set answered_at=t,option_id=case when t<=a.served_at+interval '13 seconds' then submit_answer.option_id else null end
 where session_id=p_session and player_id=auth.uid() and round_id=p_round and attempts.seq=a.seq;
 return public.serve_pending(p_session,p_round);
end $$;
create function public.submit_round(p_session uuid,p_round smallint) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.sessions; r public.round_runs; a record; streak integer:=0; best integer:=0; total integer:=0; pts integer; elapsed numeric:=0; items jsonb:='[]'; result jsonb; position bigint;
begin
 s:=public.assert_live(p_session);
 if p_round is distinct from s.current_round then raise exception 'round_not_current'; end if;
 select * into r from public.round_runs where session_id=p_session and player_id=auth.uid() and round_id=p_round for update;
 if r.session_id is null then raise exception 'round_not_started'; end if;
 if r.submitted_at is not null then return r.debrief; end if;
 if (select count(*) from public.attempts where session_id=p_session and player_id=auth.uid() and round_id=p_round and answered_at is not null)<>30 then raise exception 'round_incomplete'; end if;
 for a in select at.*,o.id correct_id,q.explanation from public.attempts at join public.questions q on q.id=at.question_id join public.options o on o.question_id=q.id and o.is_correct
 where at.session_id=p_session and at.player_id=auth.uid() and at.round_id=p_round order by at.seq loop
 if a.option_id=a.correct_id and a.answered_at<=a.served_at+interval '13 seconds' then
 streak:=streak+1;
 pts:=round((100+50*greatest(0,12-extract(epoch from a.answered_at-a.served_at))/12)*(case when streak>=6 then 1.5 when streak>=3 then 1.2 else 1 end));
 else streak:=0;pts:=0;end if;
 best:=greatest(best,streak);total:=total+pts;elapsed:=elapsed+greatest(0,extract(epoch from a.answered_at-a.served_at));
 update public.attempts set points=pts where session_id=p_session and player_id=auth.uid() and round_id=p_round and seq=a.seq;
 items:=items||jsonb_build_array(jsonb_build_object('seq',a.seq,'question_id',a.question_id,'chosen_option',a.option_id,'correct_option',a.correct_id,'explanation',a.explanation,'points',pts));
 end loop;
 update public.round_runs set submitted_at=clock_timestamp(),total_points=total,total_time=elapsed,best_streak=best where session_id=p_session and player_id=auth.uid() and round_id=p_round;
 select rank into position from (select player_id,rank() over(order by sum(total_points) desc,sum(total_time)) from public.round_runs where session_id=p_session and submitted_at is not null group by player_id) ranks where player_id=auth.uid();
 result:=jsonb_build_object('round_id',p_round,'total_points',total,'best_streak',best,'questions',items,'cumulative_points',(select sum(total_points) from public.round_runs where session_id=p_session and player_id=auth.uid() and submitted_at is not null),'leaderboard_position',position);
 update public.round_runs set debrief=result where session_id=p_session and player_id=auth.uid() and round_id=p_round;
 return result;
end $$;

create function public.open_session(p_section text,p_closes_at timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.sessions; c text;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if p_closes_at is null or p_closes_at<=clock_timestamp() or p_closes_at>clock_timestamp()+interval '3 hours' then raise exception 'invalid_close_time'; end if;
 if not exists(select 1 from public.roster where section=p_section) then raise exception 'unknown_section'; end if;
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
create function public.go_live(p_session uuid,p_round smallint) returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; uid uuid;
begin
 uid:=public.assert_domain();
 select * into s from public.sessions where id=p_session for update;
 if s.host is distinct from uid or not exists(select 1 from public.instructors where id=uid) then raise exception 'host_only'; end if;
 if s.status='closed' or s.closes_at is null or clock_timestamp()>=s.closes_at then raise exception 'session_closed'; end if;
 if p_round is null or p_round<>coalesce(s.current_round,0)+1 or p_round>9 then raise exception 'round_out_of_order'; end if;
 if exists(select 1 from public.round_runs where session_id=p_session and round_id=s.current_round and submitted_at is null) then raise exception 'players_still_answering'; end if;
 update public.sessions set status='live',current_round=p_round,started_at=coalesce(started_at,clock_timestamp()) where id=p_session;
 perform realtime.send(jsonb_build_object('round',p_round),'round_started','session:'||p_session,true);
end $$;
create function public.end_session(p_session uuid) returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
 uid:=public.assert_domain();
 if not exists(select 1 from public.sessions s join public.instructors i on i.id=s.host where s.id=p_session and s.host=uid) then raise exception 'host_only'; end if;
 update public.sessions set status='closed' where id=p_session;
 perform realtime.send('{}'::jsonb,'session_ended','session:'||p_session,true);
end $$;

-- No client table policies: neither direct reads nor writes are permitted.
do $$ declare t text; begin
 foreach t in array array['allowed_domains','roster','instructors','rounds','questions','options','players','sessions','round_runs','attempts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end $$;
revoke all on all sequences in schema public from public,anon,authenticated;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.join_session(text,text,text),public.start_round(uuid,smallint),public.next_question(uuid,smallint),public.submit_answer(uuid,smallint,smallint,bigint),public.submit_round(uuid,smallint),public.open_session(text,timestamptz),public.go_live(uuid,smallint),public.end_session(uuid) to authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
