import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { appPath } from './paths';

// Public demonstration content only. No key, scoring, or database connection.
const options = [
  'Foreign key',
  'Primary key',
  'Default value',
  'Nullable column',
];
const duration = 12_000;

// Two tempters that appear once a student is past the halfway mark, each
// pointing at a different option to rush and confuse them. They never point at
// the real answer (the client has no key), so they add pressure, not hints.
function pickTwo() {
  const red = Math.floor(Math.random() * 4);
  let blue = Math.floor(Math.random() * 3);
  if (blue >= red) blue += 1;
  return { red, blue };
}
const Devil = () => (
  <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
    <path d="M8 8 L11 3 L13 9 Z" fill="#b33124" />
    <path d="M24 8 L21 3 L19 9 Z" fill="#b33124" />
    <circle cx="16" cy="18" r="11" fill="#e05a45" />
    <circle cx="12.5" cy="18" r="1.7" fill="#3a0f0a" />
    <circle cx="19.5" cy="18" r="1.7" fill="#3a0f0a" />
    <path
      d="M10 14.5 l4 2 M22 14.5 l-4 2 M11 23 q5 3.5 10 0"
      stroke="#3a0f0a"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);
const Angel = () => (
  <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
    <ellipse
      cx="16"
      cy="5"
      rx="7"
      ry="2.4"
      fill="none"
      stroke="#f2c94c"
      strokeWidth="1.6"
    />
    <circle cx="16" cy="18" r="11" fill="#4a90d9" />
    <circle cx="12.5" cy="17" r="1.7" fill="#12314f" />
    <circle cx="19.5" cy="17" r="1.7" fill="#12314f" />
    <path
      d="M11 21 q5 3.5 10 0"
      stroke="#12314f"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

export function QuestionPreview() {
  const [phase, setPhase] = useState<
    'ready' | 'running' | 'answered' | 'expired'
  >('ready');
  const [remaining, setRemaining] = useState(duration);
  const [selected, setSelected] = useState<number | null>(null);
  const [tempters, setTempters] = useState<{
    red: number;
    blue: number;
  } | null>(null);
  const deadline = useRef(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const interval = window.setInterval(() => {
      const left = Math.max(0, deadline.current - performance.now());
      setRemaining(left);
      if (left === 0) setPhase('expired');
    }, 50);
    return () => window.clearInterval(interval);
  }, [phase]);

  function start() {
    deadline.current = performance.now() + duration;
    setRemaining(duration);
    setSelected(null);
    setTempters(pickTwo());
    setPhase('running');
  }

  function handleAnswer(event: MouseEvent<HTMLButtonElement>) {
    const index = Number(event.currentTarget.dataset.optionIndex);
    if (phase !== 'running' || selected !== null) return;
    const left = Math.max(0, deadline.current - performance.now());
    setRemaining(left);
    if (left === 0) {
      setPhase('expired');
      return;
    }
    setSelected(index);
    setPhase('answered');
  }

  const tempting =
    phase === 'running' && selected === null && remaining <= duration / 2;

  return (
    <main className="question-preview">
      <header>
        <a className="brand" href={appPath()}>
          THE LOST SCHEMA
        </a>
        <span className="badge">PRACTICE PREVIEW · NOT SCORED</span>
      </header>
      <section className="question-stage" aria-labelledby="question-heading">
        <div className="round-label">
          <span>ROUND 01</span>
          <span>The Vault of Keys</span>
        </div>
        <div className="question-card">
          <div className="question-topline">
            <span className="eyebrow">
              QUESTION 01 <span className="muted">/ 30</span>
            </span>
            <div
              className="timer"
              role="timer"
              aria-label={`${Math.ceil(remaining / 1000)} seconds remaining`}
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
                  strokeDashoffset={100 - (remaining / duration) * 100}
                />
              </svg>
              <span>
                {Math.ceil(remaining / 1000)}
                <small>SEC</small>
              </span>
            </div>
          </div>
          <h1 id="question-heading">
            {phase === 'ready'
              ? 'Ready when you are.'
              : 'Which key identifies every row?'}
          </h1>
          <p className="question-instruction">
            {phase === 'ready'
              ? 'The question and its four answers stay hidden until you start the timer.'
              : 'Choose one answer. Keep exploring.'}
          </p>
          {phase === 'ready' ? (
            <div className="answers-concealed" aria-hidden="true">
              <span className="conceal-mark">◇</span>
              <span>Start the timer to reveal the question.</span>
            </div>
          ) : (
            <div className="answer-options" aria-label="Answer choices">
              {options.map((option, index) => {
                const red = tempting && tempters?.red === index;
                const blue = tempting && tempters?.blue === index;
                return (
                  <button
                    key={option}
                    className={`answer-option${selected === index ? ' selected' : ''}${
                      red ? ' tempt tempt-red' : blue ? ' tempt tempt-blue' : ''
                    }`}
                    disabled={phase !== 'running'}
                    aria-pressed={selected === index}
                    data-option-index={index}
                    onClick={handleAnswer}
                  >
                    <span className="option-letter">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <span>{option}</span>
                    {selected === index && (
                      <span className="selection-label">Selected</span>
                    )}
                    {red && (
                      <span className="tempter tempter-red">
                        <span className="tempter-bubble">
                          Quick — this one!
                        </span>
                        <Devil />
                      </span>
                    )}
                    {blue && (
                      <span className="tempter tempter-blue">
                        <span className="tempter-bubble">No, pick me!</span>
                        <Angel />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="question-controls">
            <p role="status">
              {phase === 'ready'
                ? 'Ready? You have 12 seconds.'
                : phase === 'running'
                  ? tempting
                    ? 'Two voices are rushing you — decide for yourself.'
                    : 'Your choice stays sealed until the debrief.'
                  : phase === 'answered'
                    ? 'Choice recorded for this preview. No feedback yet.'
                    : 'Time’s up. No answer recorded.'}
            </p>
            {phase !== 'running' && (
              <button className="start-timer" onClick={start}>
                {phase === 'ready' ? 'Start timer' : 'Try again'}{' '}
                <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        </div>
        <p className="preview-note">
          One-question practice · The timer starts when you’re ready.
        </p>
      </section>
      <footer>
        <span>One answer. One step forward.</span>
        <span>No hints. No scores. Just the next step.</span>
        <a className="credit" href="https://vishnugandarapu.in">
          Built by Vishnu Gandarapu
        </a>
      </footer>
    </main>
  );
}
