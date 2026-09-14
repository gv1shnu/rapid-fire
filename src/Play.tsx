import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { JerryTempter } from './JerryTempter';
import { instructorRpc, previewPools, supabase } from './instructor-api';
import {
  parseLeaderboard,
  parsePayload,
  parseResult,
  parseState,
  studentRpc,
  type Body,
  type LeaderboardRow,
  type Question,
  type Result,
  type StudentState,
} from './student-api';

function Content({ body }: { body: Body }) {
  return (
    <>
      {body.text && <span>{body.text}</span>}
      {body.code_html && (
        <pre>
          <code>{body.code_html}</code>
        </pre>
      )}
      {body.table_json && (
        <table>
          <thead>
            <tr>
              {body.table_json.cols.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.table_json.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c === null ? 'NULL' : String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
type View = {
  owner: string;
  session: StudentState | null;
  question: Question | null;
  result: Result | null;
  leaderboard: LeaderboardRow[] | null;
  pending: string | null | undefined;
  error: string;
  deadline: number;
};
// The rapid fire always spans the nine lecture rounds; the student sees one
// continuous question counter across all of them (e.g. Q34 / 99).
const TOTAL_ROUNDS = 9;
// Muted gold, sage, mineral and clay accents on the evergreen card.
const ROUND_ACCENTS = [
  '#cbb783',
  '#aabb91',
  '#8fb9a5',
  '#91b7bd',
  '#a2acc6',
  '#b5a6bd',
  '#c3a29a',
  '#c5ac8f',
  '#b9bd99',
];
// Each round is a themed lecture; label the card so rounds feel distinct as the
// student flows through them. Titles are public flavor names, never answers.
const roundTitle = (id: number) =>
  previewPools.find((p) => p.id === id)?.title ?? `Round ${id}`;
const empty: View = {
  owner: '',
  session: null,
  question: null,
  result: null,
  leaderboard: null,
  pending: undefined,
  error: '',
  deadline: 0,
};

export function Play({ code }: { code: string }) {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [view, setView] = useState<View>(empty);
  const [now, setNow] = useState(() => performance.now());
  const command = useRef<(option: string | null) => void>(() => {});
  const retry = useRef<() => void>(() => {});
  const review = useRef<(round: number) => void>(() => {});
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let authEvent = false;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active && !authEvent) {
          setUser(data.session?.user ?? null);
          setChecked(true);
        }
      })
      .catch(() => {
        if (active) setChecked(true);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authEvent = true;
      if (active) {
        setUser(session?.user ?? null);
        setChecked(true);
      }
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user || !supabase) return;
    let active = true;
    let inFlight = false;
    let sessionId: string | null = null;
    let nextPoll = 0;
    let retryAt = 0;
    let failures = 0;
    const state: View = { ...empty, owner: `${user.id}:${code}` };
    let wantedResult: number | null = null;
    const publish = () => {
      if (active) setView({ ...state });
    };
    const apply = (payload: ReturnType<typeof parsePayload>) => {
      state.pending = undefined;
      if ('round_complete' in payload) {
        // Round done: re-poll at once so the player's next round is served with
        // no wait (self-paced auto-advance).
        state.question = null;
        nextPoll = 0;
      } else {
        if (
          payload.session_id !== sessionId ||
          payload.round_id !== state.session?.current_round
        )
          throw new Error('Stale question response. Reconnecting.');
        state.question = payload;
        // Anchor to server time and a monotonic clock; changing the device clock cannot reset it.
        state.deadline =
          performance.now() +
          Math.max(
            0,
            Date.parse(payload.deadline) - Date.parse(payload.server_now),
          );
        state.result = null;
      }
    };
    async function tick() {
      if (!active || inFlight || performance.now() < retryAt) return;
      inFlight = true;
      try {
        if (!sessionId) {
          const joined = await instructorRpc<{ session_id: string }>(
            'join_session',
            {
              code,
              nickname: (user!.email?.split('@')[0] || 'Explorer').slice(0, 30),
              avatar_seed: user!.id,
            },
          );
          if (!active) return;
          if (typeof joined?.session_id !== 'string')
            throw new Error('Invalid join response.');
          sessionId = joined.session_id;
        }
        if (performance.now() >= nextPoll) {
          const session = await studentRpc(
            'student_state',
            { p_session: sessionId },
            parseState,
          );
          if (!active) return;
          if (session.session_id !== sessionId)
            throw new Error('Invalid session response.');
          const changed =
            state.session?.current_round !== session.current_round;
          if (changed || session.status === 'closed' || session.done) {
            state.question = null;
            state.pending = undefined;
          }
          if (changed || session.status === 'closed') state.result = null;
          state.session = session;
          nextPoll = performance.now() + 2500;
          // Standings unlock once this player has finished every round (done),
          // and stay live afterwards as classmates finish; re-fetching each poll
          // keeps them current. Solutions remain sealed until the session closes.
          if (session.done || session.status === 'closed') {
            const board = await studentRpc(
              'session_leaderboard',
              { p_session: sessionId },
              parseLeaderboard,
            );
            if (!active) return;
            state.leaderboard = board;
          } else if (state.leaderboard) {
            state.leaderboard = null;
          }
          publish();
        }
        if (
          state.question &&
          state.pending === undefined &&
          performance.now() >= state.deadline
        )
          state.pending = null;
        if (state.question && state.pending !== undefined) {
          const q = state.question;
          const payload = await studentRpc(
            'submit_answer',
            {
              p_session: sessionId,
              p_round: q.round_id,
              seq: q.seq,
              option_id: state.pending,
            },
            parsePayload,
          );
          if (!active) return;
          apply(payload);
        } else if (
          !state.question &&
          state.session?.can_start &&
          state.session.current_round !== null
        ) {
          // Self-paced: keep serving the player's own current round, advancing
          // to the next one automatically as each completes.
          const payload = await studentRpc(
            'start_round',
            { p_session: sessionId, p_round: state.session.current_round },
            parsePayload,
          );
          if (!active) return;
          apply(payload);
        } else if (wantedResult !== null && !state.question) {
          const result = await studentRpc(
            'my_result',
            { p_session: sessionId, p_round: wantedResult },
            parseResult,
          );
          if (!active) return;
          state.result = result;
          wantedResult = null;
        }
        state.error = '';
        failures = 0;
        publish();
      } catch (err) {
        if (!active) return;
        const message =
          err instanceof Error ? err.message : 'Connection interrupted.';
        if (
          /session_closed|round_ended|round_not_current|admission_closed|not_session_member|domain_not_allowed/.test(
            message,
          )
        ) {
          state.question = null;
          state.result = null;
          state.pending = undefined;
          nextPoll = 0;
        }
        state.error = `${message} Your attempt is saved; reconnecting…`;
        retryAt =
          performance.now() +
          Math.min(30000, 2000 * 2 ** Math.min(failures++, 4));
        publish();
      } finally {
        inFlight = false;
      }
    }
    command.current = (option) => {
      if (
        !state.question ||
        state.pending !== undefined ||
        performance.now() >= state.deadline
      )
        return;
      state.pending = option;
      publish();
      void tick();
    };
    retry.current = () => {
      retryAt = 0;
      void tick();
    };
    review.current = (round) => {
      wantedResult = round;
      void tick();
    };
    const timer = window.setInterval(() => {
      setNow(performance.now());
      void tick();
    }, 200);
    void tick();
    return () => {
      active = false;
      window.clearInterval(timer);
      command.current = () => {};
      retry.current = () => {};
      review.current = () => {};
    };
  }, [user, code]);

  async function signIn() {
    const redirect = new URL('/', window.location.origin);
    redirect.searchParams.set('j', code);
    try {
      const result = await supabase!.auth.signInWithOAuth({
        provider: 'google',
        options: { scopes: 'openid email profile', redirectTo: redirect.href },
      });
      if (result.error) throw result.error;
    } catch (err) {
      setView({
        ...empty,
        error: err instanceof Error ? err.message : 'Sign-in failed.',
      });
    }
  }
  if (!supabase)
    return (
      <main className="question-preview">
        <p role="status">This lab is not configured to run here.</p>
      </main>
    );
  if (!user)
    return (
      <main className="instructor-page">
        <section className="setup-panel">
          <h1>Join the rapid fire</h1>
          <p>
            {checked
              ? 'Sign in with your college Google account to join.'
              : 'Checking sign-in…'}
          </p>
          {view.error && <p role="alert">{view.error}</p>}
          {checked && (
            <button className="start-timer" onClick={() => void signIn()}>
              Sign in with Google
            </button>
          )}
          <p>
            <a href="/privacy.html">Privacy policy</a> ·{' '}
            <a href="/terms.html">Terms of service</a>
          </p>
        </section>
      </main>
    );
  const activeView = view.owner === `${user.id}:${code}` ? view : empty;
  const { question: q, result, session, pending, error } = activeView;
  const remaining = Math.max(0, Math.ceil((activeView.deadline - now) / 1000));
  const tempting =
    !!q?.tempt_options &&
    pending === undefined &&
    remaining > 0 &&
    remaining <= q.seconds_per_question / 2;
  const playerName = (user.email?.split('@')[0] || 'Explorer').slice(0, 30);
  return (
    <main className="question-preview">
      <header>
        <a className="brand" href="/">
          THE LOST SCHEMA
        </a>
        <span className="badge">RAPID FIRE</span>
        <span className="player-name" title={user.email}>
          {playerName}
        </span>
      </header>
      <section className="question-stage">
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button onClick={() => retry.current()}>Reconnect now</button>
          </div>
        )}
        {q ? (
          <div
            className="question-card live-question"
            style={
              {
                '--round-accent':
                  ROUND_ACCENTS[q.round_id - 1] ?? ROUND_ACCENTS[0],
              } as CSSProperties
            }
          >
            <div className="question-topline">
              <div className="question-labels">
                <span className="round-tag">
                  ROUND {String(q.round_id).padStart(2, '0')} ·{' '}
                  {roundTitle(q.round_id)}
                </span>
                <span className="eyebrow">
                  QUESTION{' '}
                  {String((q.round_id - 1) * q.question_count + q.seq).padStart(
                    2,
                    '0',
                  )}{' '}
                  <span className="muted">
                    / {TOTAL_ROUNDS * q.question_count}
                  </span>
                </span>
              </div>
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
                    strokeDashoffset={
                      100 -
                      Math.min(1, remaining / q.seconds_per_question) * 100
                    }
                  />
                </svg>
                <span>
                  {remaining}
                  <small>SEC</small>
                </span>
              </div>
            </div>
            <h1>{q.stem}</h1>
            <Content body={q.body} />
            <p className="question-instruction">Choose one answer.</p>
            <div className="answer-options" aria-label="Answer choices">
              {q.options.map((o, i) => (
                <button
                  key={o.id}
                  className={`answer-option${pending === o.id ? ' selected' : ''}${tempting && q.tempt_options?.includes(o.id) ? ' tempt' : ''}`}
                  disabled={pending !== undefined || remaining === 0}
                  aria-pressed={pending === o.id}
                  onClick={() => command.current(o.id)}
                >
                  <span className="option-letter">
                    {String.fromCharCode(65 + i)}
                  </span>
                  <Content body={o.body} />
                  {tempting && q.tempt_options?.includes(o.id) && (
                    <JerryTempter angel={q.tempt_options[0] === o.id} />
                  )}
                </button>
              ))}
            </div>
            <p role="status" className="question-instruction">
              {pending !== undefined
                ? 'Submitting… Your choice will be confirmed by the server.'
                : tempting
                  ? 'Two voices are pointing you at answers — decide for yourself.'
                  : 'Your choice stays sealed until the release ends.'}
            </p>
          </div>
        ) : result ? (
          <div className="debrief">
            <div className="round-label">
              <span>Round {String(result.round_id).padStart(2, '0')}</span>
              <span>Debrief · answers revealed</span>
            </div>
            <div className="debrief-score">
              <div>
                <span>Round points</span>
                <strong>{result.total_points}</strong>
              </div>
              <div>
                <span>Best streak</span>
                <strong>{result.best_streak}</strong>
              </div>
              <div>
                <span>Total at submission</span>
                <strong>{result.cumulative_points}</strong>
              </div>
            </div>
            {result.questions.map((item) => (
              <div className="debrief-q" key={item.seq}>
                <p className="debrief-stem">
                  Q{item.seq}. {item.stem}
                </p>
                <Content body={item.body} />
                <div className="debrief-options">
                  {item.options.map((o, i) => (
                    <div
                      key={o.id}
                      className={`debrief-option${o.id === item.correct_option ? ' correct' : o.id === item.chosen_option ? ' wrong' : ''}`}
                    >
                      <span className="option-letter">
                        {String.fromCharCode(65 + i)}
                      </span>
                      <Content body={o.body} />
                      {o.id === item.correct_option && (
                        <span className="tag correct-tag">Correct</span>
                      )}
                      {o.id === item.chosen_option && (
                        <span className="tag">Your pick</span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="debrief-explain">{item.explanation}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="question-card">
            <h1>
              {session?.status === 'closed'
                ? 'The rapid fire has ended.'
                : session?.done
                  ? 'You finished the rapid fire.'
                  : session
                    ? 'Loading your next question…'
                    : 'Joining the rapid fire…'}
            </h1>
            <p role="status">
              {session?.status === 'closed'
                ? 'Correct answers are revealed below.'
                : session?.done
                  ? 'Your standings are live below. Correct answers reveal once everyone’s time is up.'
                  : 'Hang tight — your next question is on its way.'}
            </p>
          </div>
        )}
        {!q && session && session.results.length > 0 && (
          <nav className="review-nav" aria-label="Completed rounds">
            {session.results.map((r) => (
              <button key={r} onClick={() => review.current(r)}>
                Review round {r}
              </button>
            ))}
          </nav>
        )}
        {!q &&
          (session?.done || session?.status === 'closed') &&
          activeView.leaderboard && (
            <section className="leaderboard" aria-label="Leaderboard">
              <div className="round-label">
                <span>Leaderboard</span>
                <span>
                  {session?.status === 'closed'
                    ? 'Rapid fire complete'
                    : 'Live standings'}
                </span>
              </div>
              {activeView.leaderboard.length === 0 ? (
                <p role="status">No scores were recorded this session.</p>
              ) : (
                <ol>
                  {activeView.leaderboard.map((row, i) => (
                    <li
                      key={i}
                      className={row.is_me ? 'me' : undefined}
                      aria-current={row.is_me ? 'true' : undefined}
                    >
                      <span className="rank">{row.rank}</span>
                      <span className="who">
                        {row.name}
                        {row.is_me && <span className="you-tag">You</span>}
                      </span>
                      <span className="pts">{row.points}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        {!q && (session?.done || session?.status === 'closed') && (
          <a
            className="practice-cta"
            href="https://github.com/gv1shnu/treasure-hunt"
          >
            More coding practice on the basics → Dilli Khoj ↗
          </a>
        )}
      </section>
      <footer>
        <span>One attempt per student, per round.</span>
        <span>
          <a href="/privacy.html">Privacy policy</a> ·{' '}
          <a href="/terms.html">Terms of service</a>
        </span>
      </footer>
    </main>
  );
}
