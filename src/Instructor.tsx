import { useEffect, useState } from 'react';
import { InstructorReports } from './InstructorReports';
import {
  instructorRpc,
  parseInstructorSessions,
  previewPools,
  supabase,
  type InstructorSession,
  type InstructorState,
} from './instructor-api';

const storageKey = 'lost-schema-instructor-preview';
type PreviewSession = {
  question_count: number;
  seconds_per_question: number;
  tempters: boolean;
  closes_at: string;
  status: 'live' | 'closed';
};
function loadPreview(): PreviewSession | null {
  try {
    const value: PreviewSession | null = JSON.parse(
      sessionStorage.getItem(storageKey) ?? 'null',
    );
    if (
      !value ||
      !Number.isInteger(value.question_count) ||
      value.question_count < 1 ||
      !Number.isInteger(value.seconds_per_question) ||
      value.seconds_per_question < 1 ||
      !['live', 'closed'].includes(value.status) ||
      !Number.isFinite(Date.parse(value.closes_at ?? ''))
    )
      return null;
    const normalized = { ...value, tempters: value.tempters !== false };
    return Date.now() >= Date.parse(normalized.closes_at)
      ? { ...normalized, status: 'closed' }
      : normalized;
  } catch {
    return null;
  }
}
function durationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes
    ? `${minutes} min${rest ? ` ${rest} sec` : ''}`
    : `${rest} sec`;
}
function clockLabel(seconds: number) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function sessionDate(iso: string | null) {
  const at = iso ? new Date(iso) : null;
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
}

export function Instructor() {
  const isPreview = !supabase;
  const [connected, setConnected] = useState<InstructorState | null>(null);
  const [sessions, setSessions] = useState<InstructorSession[]>([]);
  const [authenticated, setAuthenticated] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewSession | null>(loadPreview);
  const [questionCount, setQuestionCount] = useState('5');
  const [seconds, setSeconds] = useState('12');
  const [tempters, setTempters] = useState(true);
  const [section, setSection] = useState('');
  const [review, setReview] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  const [sessionId, setSessionId] = useState(() => {
    try {
      return sessionStorage.getItem('lost-schema-host-session');
    } catch {
      return null;
    }
  });

  // One configuration governs the whole sitting; there is no per-round setup.
  const config = isPreview
    ? preview && {
        question_count: preview.question_count,
        seconds_per_question: preview.seconds_per_question,
        duration_seconds: preview.question_count * preview.seconds_per_question,
        tempters: preview.tempters,
      }
    : (connected?.config ?? null);
  const started = Boolean(config);
  const closesAt = isPreview
    ? (preview?.closes_at ?? null)
    : (connected?.session?.closes_at ?? null);
  const code = isPreview ? null : connected?.session?.code;
  // The single count fits every round, so the smallest lecture pool caps it.
  const minAvailable = isPreview
    ? Math.min(...previewPools.map((p) => p.available_questions))
    : (connected?.min_available ?? 0);
  const roundCount = isPreview
    ? previewPools.length
    : (connected?.rounds.length ?? 9);
  const count = Number(questionCount);
  const allotted = Number(seconds);
  const duration = count * allotted;
  const valid =
    Number.isInteger(count) &&
    count >= 1 &&
    count <= Math.min(300, minAvailable) &&
    Number.isInteger(allotted) &&
    allotted >= 1 &&
    allotted <= 120 &&
    (isPreview || section !== '' || Boolean(sessionId));
  const deadline = Date.parse(closesAt ?? '');
  const left = Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;
  const sessionStatus = isPreview
    ? preview?.status
    : connected?.session?.status;
  const ended = Boolean(
    started && (sessionStatus === 'closed' || (now > 0 && left === 0)),
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(isPreview ? Date.now() : performance.now() + serverOffset),
      250,
    );
    return () => window.clearInterval(timer);
  }, [serverOffset, isPreview]);

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setAuthenticated(session?.user.id ?? null),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (isPreview || !authenticated) return;
    let active = true;
    async function refresh() {
      try {
        const state = await instructorRpc<InstructorState>('instructor_state', {
          p_session: sessionId,
        });
        if (!active) return;
        setConnected(state);
        setServerOffset(Date.parse(state.server_now) - performance.now());
        setError('');
      } catch (err) {
        if (active)
          setError(
            err instanceof Error ? err.message : 'Could not refresh the state.',
          );
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isPreview, authenticated, sessionId]);

  // Every rapid fire this instructor has run, newest first, so past sessions
  // and their reports stay reachable after the tab forgets the active one.
  useEffect(() => {
    if (isPreview || !authenticated) return;
    let active = true;
    instructorRpc<unknown>('instructor_sessions')
      .then((data) => {
        if (active) setSessions(parseInstructorSessions(data));
      })
      .catch(() => {
        // Non-fatal: the main state fetch surfaces any connection error.
      });
    return () => {
      active = false;
    };
  }, [isPreview, authenticated, sessionId]);

  async function signIn() {
    const { error: authError } = await supabase!.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'openid email profile',
        redirectTo: `${window.location.origin}/instructor`,
      },
    });
    if (authError) setError(authError.message);
  }

  async function start() {
    if (!valid || busy || started) return;
    setBusy(true);
    setError('');
    try {
      if (isPreview) {
        const next: PreviewSession = {
          question_count: count,
          seconds_per_question: allotted,
          tempters,
          // A short demo window so the preview countdown is visible.
          closes_at: new Date(Date.now() + duration * 1000).toISOString(),
          status: 'live',
        };
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        setNow(Date.now());
        setPreview(next);
      } else {
        let id = sessionId;
        if (!id) {
          const opened = await instructorRpc<{ session_id: string }>(
            'open_session',
            {
              p_section: section,
              // Safety cap: the session auto-closes an hour after opening. The
              // instructor normally ends it early once the class is done.
              p_closes_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
          );
          id = opened.session_id;
          setSessionId(id);
          sessionStorage.setItem('lost-schema-host-session', id);
        }
        await instructorRpc('start_rapid_fire', {
          p_session: id,
          p_count: count,
          p_seconds: allotted,
          p_tempters: tempters,
        });
        const state = await instructorRpc<InstructorState>('instructor_state', {
          p_session: id,
        });
        setConnected(state);
        setServerOffset(Date.parse(state.server_now) - performance.now());
      }
      setReview(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the rapid fire.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function endRun() {
    if (!started || busy) return;
    setBusy(true);
    setError('');
    try {
      if (isPreview) {
        const next: PreviewSession = { ...preview!, status: 'closed' };
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        setPreview(next);
      } else {
        await instructorRpc('end_session', { p_session: sessionId });
        setConnected(
          await instructorRpc<InstructorState>('instructor_state', {
            p_session: sessionId,
          }),
        );
      }
      setConfirmEnd(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not end the rapid fire.',
      );
    } finally {
      setBusy(false);
    }
  }

  function newPreview() {
    sessionStorage.removeItem(storageKey);
    setPreview(null);
    setQuestionCount('5');
    setSeconds('12');
    setTempters(true);
    setReview(false);
    setConfirmEnd(false);
  }

  // Open a past rapid fire: the state effect reloads it (and its report) by id.
  function viewSession(id: string) {
    if (id === sessionId) return;
    setReview(false);
    setConfirmEnd(false);
    setError('');
    setSessionId(id);
    try {
      sessionStorage.setItem('lost-schema-host-session', id);
    } catch {
      // Private mode: navigation still works for this tab.
    }
  }

  // Leave the current session and return to the setup screen for a new one.
  function newSession() {
    setReview(false);
    setConfirmEnd(false);
    setError('');
    setSection('');
    setConnected((prev) =>
      prev ? { ...prev, session: null, config: null } : prev,
    );
    setSessionId(null);
    try {
      sessionStorage.removeItem('lost-schema-host-session');
    } catch {
      // Nothing stored to clear.
    }
  }

  return (
    <main className="instructor-page">
      <header>
        <a className="brand" href="/">
          THE LOST SCHEMA
        </a>
        <span className="badge">INSTRUCTOR</span>
      </header>
      <div className="instructor-heading">
        <div>
          <p className="eyebrow">THE CONTROL ROOM</p>
          <h1>Set the pace.</h1>
          <p>
            Set the questions and the clock once. Every lecture round runs back
            to back, at each student’s own pace.
          </p>
        </div>
        <a className="subtle-link" href="/?preview=question">
          View a sample question
        </a>
      </div>
      {isPreview && (
        <div className="preview-banner">
          Setup preview · Try the controls here. No live student session is
          created.
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error === 'host_only'
            ? 'This account is not an authorized instructor for this session.'
            : error}
        </p>
      )}
      {!isPreview && !authenticated ? (
        <section className="setup-panel">
          <h2>Instructor access</h2>
          <p>
            Sign in with your college Google account to manage a rapid fire.
          </p>
          <button className="start-timer" onClick={() => void signIn()}>
            Sign in with Google
          </button>
        </section>
      ) : !isPreview && !connected ? (
        <p role="status">Checking instructor access…</p>
      ) : (
        <div className="instructor-layout">
          <section className="setup-panel" aria-labelledby="setup-title">
            {started ? (
              <>
                <div className="panel-heading">
                  <span className={`release-pill ${ended ? 'ended' : ''}`}>
                    {ended ? 'ENDED' : 'LIVE'}
                  </span>
                  <span className="muted">All {roundCount} rounds</span>
                </div>
                <h2 id="setup-title">
                  {ended
                    ? 'The rapid fire has ended.'
                    : 'The rapid fire is underway.'}
                </h2>
                <p>
                  {ended
                    ? 'No new answers are accepted. Answers are in each student’s debrief.'
                    : 'Students self-pace through every round. Each question has its own timer.'}
                </p>
                {!ended && (
                  <>
                    <div
                      className="release-clock"
                      role="timer"
                      aria-label={`${left} seconds until automatic close`}
                    >
                      {now > 0 ? clockLabel(left) : '—'}
                    </div>
                    <p className="clock-caption">
                      TIME UNTIL AUTOMATIC CLOSE · END EARLY WHEN THE CLASS IS
                      DONE
                    </p>
                  </>
                )}
                <dl className="release-settings">
                  <div>
                    <dt>Questions per round</dt>
                    <dd>{config!.question_count}</dd>
                  </div>
                  <div>
                    <dt>Seconds per question</dt>
                    <dd>{config!.seconds_per_question}</dd>
                  </div>
                  <div>
                    <dt>Jerry hints</dt>
                    <dd>{config!.tempters ? 'On' : 'Off'}</dd>
                  </div>
                  {!isPreview && (
                    <>
                      <div>
                        <dt>Students joined</dt>
                        <dd>{connected!.students_joined}</dd>
                      </div>
                      <div>
                        <dt>Finished all rounds</dt>
                        <dd>
                          {connected!.students_done} /{' '}
                          {connected!.students_joined}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
                {!isPreview && !ended && code && (
                  <div className="join-share">
                    <span className="field-label">
                      Share this link with students
                    </span>
                    <code className="join-link">
                      {window.location.origin}/?j={code}
                    </code>
                    <p className="clock-caption">
                      They sign in and join. Code: {code}
                    </p>
                  </div>
                )}
                {!ended && !confirmEnd && (
                  <button
                    className="end-button"
                    onClick={() => setConfirmEnd(true)}
                  >
                    End rapid fire
                  </button>
                )}
                {confirmEnd && (
                  <div className="approval-panel">
                    <h3>End for all students?</h3>
                    <p>
                      Every unanswered question becomes a timeout, final scores
                      are recorded, and answers are revealed. This cannot be
                      reopened.
                    </p>
                    <div className="approval-actions">
                      <button
                        className="end-button"
                        disabled={busy}
                        onClick={() => void endRun()}
                      >
                        {busy ? 'Ending…' : 'End for everyone'}
                      </button>
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() => setConfirmEnd(false)}
                      >
                        Keep running
                      </button>
                    </div>
                  </div>
                )}
                {ended && isPreview && (
                  <button className="plain-button" onClick={newPreview}>
                    New setup preview
                  </button>
                )}
                {ended && (
                  <p className="closed-notice">
                    This rapid fire cannot be restarted. Each student’s attempt
                    stays on record.
                  </p>
                )}
                {ended && !isPreview && (
                  <button className="plain-button" onClick={newSession}>
                    Start a new rapid fire
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="panel-heading">
                  <h2 id="setup-title">Configure rapid fire</h2>
                  <span className="muted">01 / SETUP</span>
                </div>
                <div className="pool-count">
                  <span>Rounds in this rapid fire</span>
                  <strong>{roundCount}</strong>
                </div>
                {!isPreview && !sessionId && (
                  <>
                    <label htmlFor="section">Student section</label>
                    <select
                      id="section"
                      value={section}
                      disabled={review || busy}
                      onChange={(event) => setSection(event.target.value)}
                    >
                      <option value="">Select a section</option>
                      {connected?.sections.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </>
                )}
                <div className="setting-inputs">
                  <div>
                    <label htmlFor="question-count">Questions per round</label>
                    <input
                      id="question-count"
                      type="number"
                      min="1"
                      max={Math.min(300, minAvailable)}
                      step="1"
                      value={questionCount}
                      disabled={review || busy}
                      onChange={(event) => setQuestionCount(event.target.value)}
                      aria-describedby="count-help"
                    />
                    <p id="count-help">
                      Applies to every round · up to {minAvailable} (the
                      smallest lecture’s pool)
                    </p>
                  </div>
                  <div>
                    <label htmlFor="question-seconds">
                      Seconds per question
                    </label>
                    <input
                      id="question-seconds"
                      type="number"
                      min="1"
                      max="120"
                      step="1"
                      value={seconds}
                      disabled={review || busy}
                      onChange={(event) => setSeconds(event.target.value)}
                      aria-describedby="seconds-help"
                    />
                    <p id="seconds-help">Between 1 and 120 seconds</p>
                  </div>
                </div>
                <div className="duration-calculation" aria-live="polite">
                  <div>
                    <span>PER-ROUND ANSWERING DURATION</span>
                    <strong>{valid ? durationLabel(duration) : '—'}</strong>
                  </div>
                  <p>
                    {valid
                      ? `${count === 1 ? '1 question' : `${count} questions`} × ${allotted} seconds, across all ${roundCount} rounds`
                      : 'Enter valid settings to calculate the duration.'}
                  </p>
                </div>
                <label className="tempter-toggle">
                  <input
                    type="checkbox"
                    checked={tempters}
                    disabled={review || busy}
                    onChange={(event) => setTempters(event.target.checked)}
                  />
                  <span>
                    <strong>Good &amp; evil Jerry hints</strong>
                    <small>
                      Past the halfway mark, an angel and a demon point at two
                      answers — one is correct. Off = no avatars.
                    </small>
                  </span>
                </label>
                {review ? (
                  <div className="approval-panel">
                    <h3>Ready to start?</h3>
                    <p>
                      All {roundCount} rounds go live at once with{' '}
                      {count === 1 ? '1 question' : `${count} questions`} each ·{' '}
                      {allotted} seconds per question. Students flow through
                      them at their own pace; you end the rapid fire when the
                      class is done.
                    </p>
                    <div className="approval-actions">
                      <button
                        className="start-timer"
                        disabled={busy}
                        onClick={() => void start()}
                      >
                        {busy ? 'Starting…' : 'Approve & start'}
                      </button>
                      <button
                        className="plain-button"
                        disabled={busy}
                        onClick={() => setReview(false)}
                      >
                        Edit settings
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="start-timer review-button"
                    disabled={!valid || busy}
                    onClick={() => setReview(true)}
                  >
                    Review rapid fire <span aria-hidden="true">→</span>
                  </button>
                )}
              </>
            )}
          </section>
          <aside className="release-summary">
            <p className="eyebrow">HOW IT RUNS</p>
            <h2>
              One start.
              <br />A definite finish.
            </h2>
            <ol>
              <li>
                <strong>Configure once</strong>
                <p>
                  Set questions-per-round and seconds-per-question. It applies
                  to all {roundCount} rounds.
                </p>
              </li>
              <li>
                <strong>Students self-pace</strong>
                <p>
                  Each student flows through every round back to back, with no
                  breaks and one attempt per round.
                </p>
              </li>
              <li>
                <strong>Standings, then answers</strong>
                <p>
                  A student sees the leaderboard once they finish; correct
                  answers reveal only when you end the rapid fire.
                </p>
              </li>
            </ol>
            <div className="summary-footnote">
              Wrong answers carry no negative points.
            </div>
          </aside>
          {started &&
            ended &&
            (isPreview ? (
              <p className="closed-notice">
                Leaderboard and detailed reports are available in a live session
                after it ends.
              </p>
            ) : (
              connected?.session && (
                <InstructorReports
                  key={`${authenticated}:${connected.session.id}`}
                  session={connected.session.id}
                  rounds={connected.rounds}
                />
              )
            ))}
          {!isPreview && sessions.length > 0 && (
            <section className="session-history" aria-label="Past rapid fires">
              <div className="panel-heading">
                <h2>Past rapid fires</h2>
                <span className="muted">
                  {sessions.length === 1
                    ? '1 session'
                    : `${sessions.length} sessions`}
                </span>
              </div>
              <ul>
                {sessions.map((item) => {
                  const active = item.id === connected?.session?.id;
                  return (
                    <li key={item.id} className={active ? 'active' : undefined}>
                      <div className="session-meta">
                        <span className="session-when">
                          {sessionDate(item.started_at)}
                        </span>
                        <span className="session-section">{item.section}</span>
                        <span
                          className={`release-pill ${item.status === 'closed' ? 'ended' : ''}`}
                        >
                          {item.status === 'closed' ? 'ENDED' : 'LIVE'}
                        </span>
                      </div>
                      <div className="session-stats">
                        <span>
                          {item.students_done}/{item.students_joined} finished
                        </span>
                        {item.question_count != null && (
                          <span>
                            {item.question_count}×{item.seconds_per_question}s
                          </span>
                        )}
                        <span className="session-code">{item.code}</span>
                      </div>
                      <button
                        className="plain-button"
                        disabled={active}
                        onClick={() => viewSession(item.id)}
                      >
                        {active
                          ? 'Viewing'
                          : item.status === 'closed'
                            ? 'View report'
                            : 'Open'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
      <footer>
        <span>Built for the DBMS lab.</span>
        <span>
          Standings appear once a student finishes; answers stay hidden until
          the whole rapid fire ends.
        </span>
      </footer>
    </main>
  );
}
