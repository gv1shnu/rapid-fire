import { useEffect, useState } from 'react';
import {
  instructorRpc,
  previewPools,
  supabase,
  type InstructorState,
  type Release,
} from './instructor-api';

const storageKey = 'lost-schema-instructor-preview';
function loadPreview(): Release | null {
  try {
    const value: Release | null = JSON.parse(
      sessionStorage.getItem(storageKey) ?? 'null',
    );
    if (
      !value ||
      !['live', 'ended'].includes(value.status) ||
      !Number.isInteger(value.question_count) ||
      value.question_count < 1 ||
      !Number.isInteger(value.seconds_per_question) ||
      value.seconds_per_question < 1 ||
      !Number.isFinite(Date.parse(value.closes_at ?? ''))
    )
      return null;
    return value.status === 'live' && Date.now() >= Date.parse(value.closes_at!)
      ? { ...value, status: 'ended', ended_at: value.closes_at }
      : value;
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
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function Instructor() {
  const isPreview = !supabase;
  const [connected, setConnected] = useState<InstructorState | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [preview, setPreview] = useState<Release | null>(loadPreview);
  const [roundId, setRoundId] = useState(1);
  const [questionCount, setQuestionCount] = useState('30');
  const [seconds, setSeconds] = useState('12');
  const [section, setSection] = useState('');
  const [review, setReview] = useState(false);
  const [preparingNext, setPreparingNext] = useState(false);
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
  const release = isPreview ? preview : connected?.release;
  const pools = isPreview ? previewPools : (connected?.rounds ?? []);
  const selectedPool = pools.find((pool) => pool.id === roundId);
  const count = Number(questionCount);
  const allotted = Number(seconds);
  const duration = count * allotted;
  const valid =
    Number.isInteger(count) &&
    count >= 1 &&
    count <= Math.min(300, selectedPool?.available_questions ?? 0) &&
    Number.isInteger(allotted) &&
    allotted >= 1 &&
    allotted <= 120 &&
    duration < 10800 &&
    (isPreview || section !== '' || Boolean(sessionId));
  const deadline = Date.parse(
    release?.admission_closes_at ?? release?.closes_at ?? '',
  );
  const left = Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;
  const ended =
    release?.status === 'ended' ||
    (isPreview && now > 0 && release?.status === 'live' && left === 0);
  const released = Boolean(
    release && release.status !== 'draft' && !preparingNext,
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(isPreview ? Date.now() : performance.now() + serverOffset),
      100,
    );
    return () => window.clearInterval(timer);
  }, [serverOffset, isPreview]);

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setAuthenticated(Boolean(session)),
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
            err instanceof Error
              ? err.message
              : 'Could not refresh the release.',
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

  async function approve() {
    if (!valid || busy || released) return;
    setBusy(true);
    setError('');
    try {
      if (isPreview) {
        const started = Date.now();
        const next: Release = {
          round_id: roundId,
          question_count: count,
          seconds_per_question: allotted,
          duration_seconds: duration,
          status: 'live',
          started_at: new Date(started).toISOString(),
          closes_at: new Date(started + duration * 1000).toISOString(),
          ended_at: null,
        };
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        setNow(started);
        setPreview(next);
      } else {
        let id = sessionId;
        if (!id) {
          const opened = await instructorRpc<{ session_id: string }>(
            'open_session',
            {
              p_section: section,
              p_closes_at: new Date(
                Date.now() + 3 * 60 * 60 * 1000,
              ).toISOString(),
            },
          );
          id = opened.session_id;
          setSessionId(id);
          sessionStorage.setItem('lost-schema-host-session', id);
        }
        await instructorRpc('configure_round', {
          p_session: id,
          p_round: roundId,
          p_count: count,
          p_seconds: allotted,
        });
        await instructorRpc('go_live', { p_session: id, p_round: roundId });
        const state = await instructorRpc<InstructorState>('instructor_state', {
          p_session: id,
        });
        setConnected(state);
        setServerOffset(Date.parse(state.server_now) - performance.now());
      }
      setReview(false);
      setPreparingNext(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not release the rapid fire.',
      );
    } finally {
      setBusy(false);
    }
  }

  function newPreview() {
    sessionStorage.removeItem(storageKey);
    setPreview(null);
    setPreparingNext(false);
    setRoundId(1);
    setQuestionCount('30');
    setSeconds('12');
    setReview(false);
    setConfirmEnd(false);
  }

  function prepareNextRound() {
    if (!release || !ended) return;
    const nextId = release.round_id + 1;
    setRoundId(nextId);
    setQuestionCount(
      String(
        Math.min(
          release.question_count,
          pools.find((pool) => pool.id === nextId)?.available_questions ?? 0,
        ),
      ),
    );
    setSeconds(String(release.seconds_per_question));
    setReview(false);
    setConfirmEnd(false);
    setPreparingNext(true);
  }

  async function endRelease() {
    if (!release || busy) return;
    setBusy(true);
    setError('');
    try {
      if (isPreview) {
        const next: Release = {
          ...release,
          status: 'ended',
          ended_at: new Date().toISOString(),
        };
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        setPreview(next);
      } else {
        await instructorRpc('end_round', {
          p_session: sessionId,
          p_round: release.round_id,
        });
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
          <p>Choose the questions. Set the clock. Release when you’re ready.</p>
        </div>
        <a className="subtle-link" href="/?preview=question">
          View a sample question ↗
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
            {released ? (
              <>
                <div className="panel-heading">
                  <span className={`release-pill ${ended ? 'ended' : ''}`}>
                    {ended ? 'ENDED' : 'LIVE'}
                  </span>
                  <span className="muted">
                    Round {release!.round_id.toString().padStart(2, '0')}
                  </span>
                </div>
                <h2 id="setup-title">
                  {ended
                    ? 'This rapid fire is closed.'
                    : 'The rapid fire is underway.'}
                </h2>
                <p>
                  {ended
                    ? 'No new answers or repeat attempts are accepted.'
                    : 'Each question has its own timer. One attempt per student.'}
                </p>
                <div
                  className="release-clock"
                  role="timer"
                  aria-label={
                    ended ? 'Rapid fire ended' : `${left} seconds remaining`
                  }
                >
                  {ended ? '00:00' : now > 0 ? clockLabel(left) : '—'}
                </div>
                <p className="clock-caption">
                  {ended
                    ? 'Answers are available in the debrief. Results are preserved.'
                    : 'JOINING WINDOW · STARTED ATTEMPTS KEEP THEIR QUESTION TIMERS'}
                </p>
                <dl className="release-settings">
                  <div>
                    <dt>Questions released</dt>
                    <dd>{release!.question_count}</dd>
                  </div>
                  <div>
                    <dt>Seconds per question</dt>
                    <dd>{release!.seconds_per_question}</dd>
                  </div>
                  <div>
                    <dt>Nominal answering duration</dt>
                    <dd>{durationLabel(release!.duration_seconds)}</dd>
                  </div>
                </dl>
                {!isPreview && !ended && connected?.session?.code && (
                  <div className="join-share">
                    <span className="field-label">
                      Share this link with students
                    </span>
                    <code className="join-link">
                      {window.location.origin}/?j={connected.session.code}
                    </code>
                    <p className="clock-caption">
                      They sign in and join this round. Code:{' '}
                      {connected.session.code}
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
                      Remaining questions will become timeouts. This release
                      cannot be reopened.
                    </p>
                    <div className="approval-actions">
                      <button
                        className="end-button"
                        disabled={busy}
                        onClick={() => void endRelease()}
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
                {ended &&
                  pools.some(
                    (pool) =>
                      pool.id === release!.round_id + 1 &&
                      pool.available_questions > 0,
                  ) && (
                    <button className="start-timer" onClick={prepareNextRound}>
                      Configure next round →
                    </button>
                  )}
                {ended && isPreview && (
                  <button className="plain-button" onClick={newPreview}>
                    New setup preview
                  </button>
                )}
                {ended && (
                  <p className="closed-notice">
                    This release cannot be restarted. Each student’s attempt
                    stays on record.
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="panel-heading">
                  <h2 id="setup-title">Configure rapid fire</h2>
                  <span className="muted">01 / SETUP</span>
                </div>
                {/* Rounds run in sequence, so the round is never chosen — it
                    is always the next one. Shown read-only, not as a picker. */}
                <p className="field-label">Up next</p>
                <div className="round-heading">
                  <span>
                    Round {roundId.toString().padStart(2, '0')} ·{' '}
                    {selectedPool?.title ?? '—'}
                  </span>
                  <span className="muted">
                    {roundId} of {pools.length}
                  </span>
                </div>
                <div className="pool-count">
                  <span>Total questions available</span>
                  <strong>{selectedPool?.available_questions ?? 0}</strong>
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
                      max={Math.min(
                        300,
                        selectedPool?.available_questions ?? 0,
                      )}
                      step="1"
                      value={questionCount}
                      disabled={review || busy}
                      onChange={(event) => setQuestionCount(event.target.value)}
                      aria-describedby="count-help"
                    />
                    <p id="count-help">
                      This round releases this many · out of{' '}
                      {selectedPool?.available_questions ?? 0} available this
                      round
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
                    <span>NOMINAL ANSWERING DURATION</span>
                    <strong>{valid ? durationLabel(duration) : '—'}</strong>
                  </div>
                  <p>
                    {valid
                      ? `${count === 1 ? '1 question' : `${count} questions`} × ${allotted} seconds`
                      : 'Enter valid settings to calculate the duration.'}
                  </p>
                </div>
                {review ? (
                  <div className="approval-panel">
                    <h3>Ready to release?</h3>
                    <p>
                      {count === 1 ? '1 question' : `${count} questions`} ·{' '}
                      {allotted} seconds each · {durationLabel(duration)} of
                      answering time. The joining window opens on approval. Each
                      question starts its own timer when served; the instructor
                      can end the release early.
                    </p>
                    <div className="approval-actions">
                      <button
                        className="start-timer"
                        disabled={busy}
                        onClick={() => void approve()}
                      >
                        {busy ? 'Releasing…' : 'Approve & release'}
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
            <p className="eyebrow">RELEASE RULES</p>
            <h2>
              A fair start.
              <br />A definite finish.
            </h2>
            <ol>
              <li>
                <strong>Approve before release</strong>
                <p>
                  Review the question count and duration before the clock
                  begins.
                </p>
              </li>
              <li>
                <strong>One student, one attempt</strong>
                <p>
                  Returning to the release continues the same attempt. It never
                  creates a second one.
                </p>
              </li>
              <li>
                <strong>Automatic finish</strong>
                <p>
                  Each question expires separately. The release finishes after
                  admission closes and started attempts complete. You can also
                  end it early.
                </p>
              </li>
            </ol>
            <div className="summary-footnote">
              Wrong answers carry no negative points.
            </div>
          </aside>
        </div>
      )}
      <footer>
        <span>Built for the DBMS lab.</span>
        <span>
          Standings appear once a student submits; answers stay hidden until the
          whole rapid fire ends.
        </span>
      </footer>
    </main>
  );
}
