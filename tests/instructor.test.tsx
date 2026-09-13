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
  it('runs as an offline preview with one config for all rounds', () => {
    render(<Instructor />);
    expect(screen.getByText(/setup preview/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /configure rapid fire/i }),
    ).toBeVisible();
    expect(screen.getByLabelText(/questions per round/i)).toHaveValue(5);
    expect(screen.getByLabelText(/seconds per question/i)).toHaveValue(12);
    // No per-round picker: one config governs every round. Nine rounds.
    expect(screen.queryByLabelText(/question pool/i)).not.toBeInTheDocument();
    expect(screen.getByText(/rounds in this rapid fire/i)).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    // 5 x 12 = 60s per round = 1 min.
    expect(screen.getByText('1 min')).toBeInTheDocument();
    expect(reviewButton()).toBeEnabled();
  });

  it('recomputes the per-round duration for custom settings', () => {
    render(<Instructor />);
    setCount('8');
    setSeconds('15');
    expect(screen.getByText('2 min')).toBeInTheDocument();
    setSeconds('20');
    expect(screen.getByText('2 min 40 sec')).toBeInTheDocument();
  });

  it('disables start for a count over the smallest pool or out-of-range timers', () => {
    render(<Instructor />);
    setCount('0');
    expect(reviewButton()).toBeDisabled();
    // The smallest lecture pool is 9, so 10 cannot fit every round.
    setCount('10');
    expect(reviewButton()).toBeDisabled();
    setCount('9');
    expect(reviewButton()).toBeEnabled();
    setSeconds('121');
    expect(reviewButton()).toBeDisabled();
    setSeconds('0');
    expect(reviewButton()).toBeDisabled();
    setSeconds('12');
    expect(reviewButton()).toBeEnabled();
  });

  it('starts every round at once after approval and shows the countdown', async () => {
    render(<Instructor />);
    fireEvent.click(reviewButton());
    expect(
      screen.getByRole('heading', { name: /ready to start\?/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve & start/i }));

    expect(
      await screen.findByText(/the rapid fire is underway/i),
    ).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/\d\d:\d\d/);
    const settings = document.querySelector('.release-settings') as HTMLElement;
    expect(within(settings).getByText('5')).toBeInTheDocument();
    expect(within(settings).getByText('12')).toBeInTheDocument();
    // The live session is persisted so a refresh resumes it.
    expect(sessionStorage.getItem(storageKey)).toContain('"status":"live"');
  });

  it('ends the rapid fire with confirmation and no per-round handoff', async () => {
    render(<Instructor />);
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole('button', { name: /approve & start/i }));
    await screen.findByText(/the rapid fire is underway/i);

    fireEvent.click(screen.getByRole('button', { name: /^end rapid fire$/i }));
    expect(
      screen.getByRole('heading', { name: /end for all students\?/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /end for everyone/i }));

    expect(
      await screen.findByText(/the rapid fire has ended/i),
    ).toBeInTheDocument();
    expect(screen.getByText('ENDED')).toBeInTheDocument();
    // Self-paced: there is no "configure next round" step.
    expect(
      screen.queryByRole('button', { name: /configure next round/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /new setup preview/i }),
    ).toBeInTheDocument();
  });
});

describe('Instructor preview persistence', () => {
  it('restores a stored live session and closes it once its deadline has passed', () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        question_count: 5,
        seconds_per_question: 12,
        closes_at: new Date(Date.now() - 40_000).toISOString(),
        status: 'live',
      }),
    );
    render(<Instructor />);
    expect(screen.getByText(/the rapid fire has ended/i)).toBeInTheDocument();
    expect(screen.getByText('ENDED')).toBeInTheDocument();
  });

  it('ignores a malformed stored session', () => {
    sessionStorage.setItem(storageKey, '{"status":"live"}');
    render(<Instructor />);
    expect(
      screen.getByRole('heading', { name: /configure rapid fire/i }),
    ).toBeInTheDocument();
  });

  it('starts a fresh preview from the config form after one ends', async () => {
    render(<Instructor />);
    setCount('8');
    setSeconds('15');
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole('button', { name: /approve & start/i }));
    await screen.findByText(/the rapid fire is underway/i);
    fireEvent.click(screen.getByRole('button', { name: /^end rapid fire$/i }));
    fireEvent.click(screen.getByRole('button', { name: /end for everyone/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /new setup preview/i }),
    );
    expect(
      screen.getByRole('heading', { name: /configure rapid fire/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/questions per round/i)).toHaveValue(5);
  });
});
