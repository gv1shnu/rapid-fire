import { useEffect, useState } from 'react';
import { instructorRpc, supabase } from './instructor-api';
import { appPath, appUrl } from './paths';

// One sign-in for everyone. The server decides the role: accounts in the
// instructor allowlist get the control room; everyone else is a signed-in
// student waiting for the instructor to launch. Students never see an
// instructor link — role is resolved from the allowlist, not the UI.
type Phase = 'offline' | 'loading' | 'signedOut' | 'student' | 'instructor';

export function Home() {
  const [phase, setPhase] = useState<Phase>(supabase ? 'loading' : 'offline');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    async function resolve(session: unknown) {
      if (!session) {
        if (active) setPhase('signedOut');
        return;
      }
      try {
        // Instructors can read instructor_state; everyone else gets host_only.
        await instructorRpc('instructor_state');
        if (active) setPhase('instructor');
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : '';
        if (message && message !== 'host_only') setError(message);
        setPhase('student');
      }
    }
    void supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      resolve(session),
    );
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  async function signIn() {
    if (!supabase || busy) return;
    setBusy(true);
    setError('');
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'openid email profile',
        redirectTo: appUrl(),
      },
    });
    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setPhase('signedOut');
  }

  const status =
    phase === 'instructor'
      ? {
          title: 'You’re signed in as an instructor',
          body: 'Open the control room to set up and release a rapid fire.',
        }
      : phase === 'student'
        ? {
            title: 'You’re in. Waiting for the lab to start',
            body: 'Keep this page open — your expedition begins the moment your instructor launches the quiz.',
          }
        : {
            title: 'No lab is running right now',
            body: 'Your expedition begins when your instructor opens the session.',
          };

  return (
    <main>
      <header>
        <span className="mark" aria-hidden="true">
          ⌘
        </span>
        <span>THE LOST SCHEMA</span>
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
            <h2>{status.title}</h2>
            <p>{status.body}</p>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {phase === 'signedOut' && (
          <button
            className="start-timer"
            disabled={busy}
            onClick={() => void signIn()}
          >
            {busy ? 'Opening Google…' : 'Sign in with Google'}
          </button>
        )}
        {phase === 'instructor' && (
          <a className="start-timer" href={appPath('instructor')}>
            Open the control room →
          </a>
        )}
        {phase === 'loading' && <p role="status">Checking your session…</p>}
        {(phase === 'student' || phase === 'instructor') && (
          <button className="plain-button" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
        <a
          className="subtle-link preview-link"
          href={appPath('?preview=question')}
        >
          Try the first question →
        </a>
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
        <span className="caption">ONE TIMER PER QUESTION</span>
      </aside>
      <footer>
        <span>
          <a href={appPath('privacy.html')}>Privacy policy</a> ·{' '}
          <a href={appPath('terms.html')}>Terms of service</a>
        </span>
        <a className="credit" href="https://vishnugandarapu.in">
          Built by Vishnu Gandarapu
        </a>
      </footer>
    </main>
  );
}
