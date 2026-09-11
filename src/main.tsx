import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { QuestionPreview } from './QuestionPreview';
export function App() {
  if (
    new URLSearchParams(window.location.search).get('preview') === 'question'
  ) {
    return <QuestionPreview />;
  }
  return (
    <main>
      <header>
        <span className="mark" aria-hidden="true">
          ⌘
        </span>
        <span>THE LOST SCHEMA</span>
        <span className="badge">DBMS LAB</span>
      </header>
      <section>
        <p className="eyebrow">NINE ROUNDS. ONE EXPEDITION.</p>
        <h1>
          Every answer.
          <br />
          One step closer.
        </h1>
        <p className="intro">
          A journey through keys, queries, and the stories hidden in data.
        </p>
        <div className="status">
          <span className="dot" />
          <div>
            <h2>No lab is running right now</h2>
            <p>
              Your expedition begins when your instructor opens the session.
            </p>
          </div>
        </div>
        <a className="start-timer preview-link" href="/?preview=question">
          Try the first question →
        </a>
        <p className="note">
          30 questions per round · 12 seconds per question
          <br />
          No scores or hints until the debrief.
        </p>
      </section>
      <aside aria-label="Expedition route">
        <span>01</span>
        <div className="vault" aria-hidden="true">
          ◇
        </div>
        <h2>The Vault of Keys</h2>
        <p>The first door is a question.</p>
        <div className="trail" aria-hidden="true">
          ◇ ─ ◇ ─ ◇ ─ ◇ ─ ◇
        </div>
        <span className="caption">30 QUESTIONS · 12 SECONDS EACH</span>
      </aside>
      <footer>
        <span>Think fast. Keep exploring.</span>
        <span>Answers revealed only after each round.</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
