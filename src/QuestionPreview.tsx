import { useEffect, useRef, useState, type MouseEvent } from 'react';

// Public demonstration content only. No key, scoring, or database connection.
const options = [
  'Foreign key',
  'Primary key',
  'Default value',
  'Nullable column',
];
const duration = 12_000;

export function QuestionPreview() {
  const [phase, setPhase] = useState<
    'ready' | 'running' | 'answered' | 'expired'
  >('ready');
  const [remaining, setRemaining] = useState(duration);
  const [selected, setSelected] = useState<number | null>(null);
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

  return (
    <main className="question-preview">
      <header>
        <a className="brand" href="/">
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
              {options.map((option, index) => (
                <button
                  key={option}
                  className={`answer-option${selected === index ? ' selected' : ''}`}
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
                </button>
              ))}
            </div>
          )}
          <div className="question-controls">
            <p role="status">
              {phase === 'ready'
                ? 'Ready? You have 12 seconds.'
                : phase === 'running'
                  ? 'Your choice stays sealed until the debrief.'
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
      </footer>
    </main>
  );
}
