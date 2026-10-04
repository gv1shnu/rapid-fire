import { appPath } from './paths';

export function NotFound() {
  return (
    <main className="instructor-page">
      <header>
        <a className="brand" href={appPath()}>
          THE LOST SCHEMA
        </a>
      </header>
      <section className="setup-panel">
        <p className="eyebrow">404 · OFF THE MAP</p>
        <h1>This path leads nowhere.</h1>
        <p>
          The page you followed doesn’t exist. If your instructor shared a join
          link, check that you copied all of it.
        </p>
        <a className="start-timer" href={appPath()}>
          Back to the expedition
        </a>
      </section>
    </main>
  );
}
