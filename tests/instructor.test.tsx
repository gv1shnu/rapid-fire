// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { Instructor } from '../src/Instructor';

const storageKey = 'lost-schema-instructor-preview';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function setCount(value: string) {
  fireEvent.change(screen.getByLabelText(/questions per round/i), {
    target: { value },
  });
}
function setSeconds(value: string) {
  fireEvent.change(screen.getByLabelText(/seconds per question/i), {
    target: { value },
  });
}
const reviewButton = () =>
  screen.getByRole('button', { name: /review rapid fire/i });

describe('Instructor setup preview', () => {
  it('runs as an offline preview with default settings and live duration math', () => {
    render(<Instructor />);
    expect(screen.getByText(/setup preview/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /configure rapid fire/i }),
    ).toBeVisible();
    expect(screen.getByLabelText(/questions per round/i)).toHaveValue(30);
    expect(screen.getByLabelText(/seconds per question/i)).toHaveValue(12);
    // Round 1 pool from previewPools has 45 available questions.
    expect(screen.getByText('45')).toBeInTheDocument();
    // 30 x 12 = 360s = 6 minutes.
    expect(screen.getByText('6 min')).toBeInTheDocument();
    expect(reviewButton()).toBeEnabled();
  });

  it('recomputes duration for custom settings', () => {
    render(<Instructor />);
    setCount('20');
    setSeconds('15');
    expect(screen.getByText('5 min')).toBeInTheDocument();
    setSeconds('20');
    expect(screen.getByText('6 min 40 sec')).toBeInTheDocument();
  });

  it('disables release for out-of-range counts and timers', () => {
    render(<Instructor />);
    setCount('0');
    expect(reviewButton()).toBeDisabled();
    setCount('46'); // exceeds the 45-question pool
    expect(reviewButton()).toBeDisabled();
    setCount('30');
    expect(reviewButton()).toBeEnabled();
    setSeconds('121');
    expect(reviewButton()).toBeDisabled();
    setSeconds('0');
    expect(reviewButton()).toBeDisabled();
    setSeconds('12');
    expect(reviewButton()).toBeEnabled();
  });

  it('shows the next round read-only instead of a pool picker', () => {
    render(<Instructor />);
    // No round dropdown: rounds run in sequence, so the round is not chosen.
    expect(screen.queryByLabelText(/question pool/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/round 01 · the vault of keys/i),
    ).toBeInTheDocument();
  });

  it('releases after approval and starts the shared countdown', async () => {
    render(<Instructor />);
    fireEvent.click(reviewButton());
    expect(
      screen.getByRole('heading', { name: /ready to release\?/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve & release/i }));

    expect(
      await screen.findByText(/the rapid fire is underway/i),
    ).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/\d\d:\d\d/);
    const settings = screen
      .getByText(/questions released/i)
      .closest('div')!.parentElement!;
    expect(within(settings).getByText('30')).toBeInTheDocument();
    expect(within(settings).getByText('12')).toBeInTheDocument();
    // The live release is persisted so a refresh resumes the same attempt.
    expect(sessionStorage.getItem(storageKey)).toContain('"status":"live"');
  });

  it('ends the rapid fire with confirmation and offers the next round', async () => {
    render(<Instructor />);
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole('button', { name: /approve & release/i }));
    await screen.findByText(/the rapid fire is underway/i);

    fireEvent.click(screen.getByRole('button', { name: /^end rapid fire$/i }));
    expect(
      screen.getByRole('heading', { name: /end for all students\?/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /end for everyone/i }));

    expect(
      await screen.findByText(/this rapid fire is closed/i),
    ).toBeInTheDocument();
    expect(screen.getByText('ENDED')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('00:00');
    expect(
      screen.getByRole('button', { name: /configure next round/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /new setup preview/i }),
    ).toBeInTheDocument();
  });
});

describe('Instructor preview persistence', () => {
  it('restores a stored live release and closes it once its deadline has passed', () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        round_id: 1,
        question_count: 30,
        seconds_per_question: 12,
        duration_seconds: 360,
        status: 'live',
        started_at: new Date(Date.now() - 400_000).toISOString(),
        closes_at: new Date(Date.now() - 40_000).toISOString(),
        ended_at: null,
      }),
    );
    render(<Instructor />);
    expect(screen.getByText(/this rapid fire is closed/i)).toBeInTheDocument();
    expect(screen.getByText('ENDED')).toBeInTheDocument();
  });

  it('ignores a malformed stored release', () => {
    sessionStorage.setItem(storageKey, '{"status":"live"}');
    render(<Instructor />);
    expect(
      screen.getByRole('heading', { name: /configure rapid fire/i }),
    ).toBeInTheDocument();
  });
});
