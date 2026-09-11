import { useCallback, useEffect, useRef, useState } from 'react';
import { instructorRpc, supabase } from './instructor-api';

// Student play. Joins a session by its code (from the shared link), then runs
// each live round: serve a question, take one answer or time out, advance, and
// wait for the instructor to release the next round. No scores mid-round.
type SessionState = {
  session_id: string;
  status: string;
  current_round: number | null;
  closes_at: string;
};
type Option = { id: number; body: { text?: string } };
type Question = {
  seq: number;
  round_id?: number;
  stem: string;
  options: Option[];
  served_at: string;
  deadline: string;
  question_count: number;
};
type Payload = Question | { round_complete: true };

const avatarSeed = () => Math.random().toString(36).slice(2, 10);

export function Play({ code }: { code: string }) {
  const isReady = Boolean(supabase);
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [doneRound, setDoneRound] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setAuthed(Boolean(data.session));
      setChecked(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) =>
      setAuthed(Boolean(s)),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  async function signIn() {
    await supabase!.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'openid email profile',
        redirectTo: window.location.href,
      },
    });
  }

  // Join, then poll the session so we learn when a round goes live or advances.
  useEffect(() => {
    if (!isReady || !authed) return;
    let active = true;
    async function tick() {
      const email =
        (await supabase!.auth.getUser()).data.user?.email ?? 'Explorer';
      const nickname = email.split('@')[0].slice(0, 30) || 'Explorer';
      try {
        const state = await instructorRpc<SessionState>('join_session', {
          code,
          nickname,
          avatar_seed: avatarSeed(),
        });
        if (active) {
          setSession(state);
          setError('');
        }
      } catch (err) {
        if (active)
          setError(err instanceof Error ? err.message : 'Could not join.');
      }
    }
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isReady, authed, code]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, []);

  const apply = useCallback((payload: Payload, round: number) => {
    if ('round_complete' in payload) {
      setQuestion(null);
      setDoneRound(round);
    } else {
      setQuestion(payload);
      setSelected(null);
      setDoneRound(null);
    }
  }, []);

  // Start the current round when it is live and we are not already in it.
  useEffect(() => {
    if (!session || question) return;
    const round = session.current_round;
    if (session.status !== 'live' || round == null) return;
    if (doneRound === round) return;
    if (busy.current) return;
    busy.current = true;
    void instructorRpc<Payload>('start_round', {
      p_session: session.session_id,
      p_round: round,
    })
      .then((payload) => apply(payload, round))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Could not start.'),
      )
      .finally(() => {
        busy.current = false;
      });
  }, [session, question, doneRound, apply]);

  const answer = useCallback(
    async (optionId: number | null) => {
      if (!session || !question || busy.current) return;
      busy.current = true;
      try {
        const payload = await instructorRpc<Payload>('submit_answer', {
          p_session: session.session_id,
          p_round: question.round_id ?? session.current_round,
          seq: question.seq,
          option_id: optionId,
        });
        apply(payload, question.round_id ?? session.current_round!);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not submit.');
      } finally {
        busy.current = false;
      }
    },
    [session, question, apply],
  );

  // Auto-timeout when the per-question deadline passes with no answer.
  const deadline = question ? Date.parse(question.deadline) : 0;
  useEffect(() => {
    if (question && selected === null && now >= deadline && !busy.current) {
      void answer(null);
    }
  }, [question, selected, now, deadline, answer]);

  function choose(optionId: number, index: number) {
    if (selected !== null || busy.current) return;
    setSelected(index);
    void answer(optionId);
  }

  if (!isReady) {
    return (
      <main className="question-preview">
        <p role="status">This lab is not configured to run here.</p>
      </main>
    );
  }
  if (checked && !authed) {
    return (
      <main className="instructor-page">
        <section className="setup-panel">
          <h2>Join the rapid fire</h2>
          <p>Sign in with your college Google account to join.</p>
          <button className="start-timer" onClick={() => void signIn()}>
            Sign in with Google
          </button>
        </section>
      </main>
    );
  }

  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  const secondsTotal =
    question && Number.isFinite(deadline)
      ? Math.max(
          1,
          Math.round((deadline - Date.parse(question.served_at)) / 1000),
        )
      : 1;

  return (
    <main className="question-preview">
      <header>
        <a className="brand" href="/">
          THE LOST SCHEMA
        </a>
        <span className="badge">RAPID FIRE · LIVE</span>
      </header>
      <section className="question-stage">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {question ? (
          <div className="question-card">
            <div className="question-topline">
              <span className="eyebrow">
                QUESTION {question.seq.toString().padStart(2, '0')}{' '}
                <span className="muted">/ {question.question_count}</span>
              </span>
              <div
                className="timer"
                role="timer"
                aria-label={`${remaining} seconds remaining`}
              >
                <svg viewBox="0 0 80 80" aria-hidden="true">
                  <circle className="timer-track" cx="40" cy="40" r="35" />
                  <circle
                    className="timer-progress"
                    cx="40"
                    cy="40"
                    r="35"
                    pathLength="100"
                    strokeDasharray="100"
                    strokeDashoffset={100 - (remaining / secondsTotal) * 100}
                  />
                </svg>
                <span>
                  {remaining}
                  <small>SEC</small>
                </span>
              </div>
            </div>
            <h1>{question.stem}</h1>
            <p className="question-instruction">
              Choose one answer. Keep exploring.
            </p>
            <div className="answer-options" aria-label="Answer choices">
              {question.options.map((option, index) => (
                <button
                  key={option.id}
                  className={`answer-option${selected === index ? ' selected' : ''}`}
                  disabled={selected !== null}
                  aria-pressed={selected === index}
                  onClick={() => choose(option.id, index)}
                >
                  <span className="option-letter">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span>{option.body.text}</span>
                </button>
              ))}
            </div>
            <p role="status" className="question-instruction">
              {selected !== null
                ? 'Answer recorded. Next question loading…'
                : 'Your choice stays sealed until the debrief.'}
            </p>
          </div>
        ) : doneRound != null ? (
          <div className="question-card">
            <h1>Round {doneRound.toString().padStart(2, '0')} complete.</h1>
            <p className="question-instruction">
              Sit tight — the next round begins when your instructor releases
              it. Scores are revealed at the debrief.
            </p>
          </div>
        ) : (
          <div className="question-card">
            <h1>You’re in.</h1>
            <p className="question-instruction">
              {session
                ? 'Waiting for the round to begin…'
                : 'Joining the rapid fire…'}
            </p>
          </div>
        )}
      </section>
      <footer>
        <span>One answer. One step forward.</span>
        <span>No hints. No scores until the debrief.</span>
      </footer>
    </main>
  );
}
