// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { QuestionPreview } from '../src/QuestionPreview';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'Date',
      'performance',
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function startTimer() {
  fireEvent.click(screen.getByRole('button', { name: /start timer/i }));
}

describe('QuestionPreview', () => {
  it('starts sealed: options disabled, no scoring copy, twelve seconds shown', () => {
    render(<QuestionPreview />);
    expect(
      screen.getByText(/ready\? you have 12 seconds/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('12');
    for (const label of [
      'Foreign key',
      'Primary key',
      'Default value',
      'Nullable column',
    ]) {
      expect(
        screen.getByRole('button', { name: new RegExp(label, 'i') }),
      ).toBeDisabled();
    }
    expect(screen.getByText(/^A$/)).toBeInTheDocument();
    expect(screen.getByText(/^D$/)).toBeInTheDocument();
  });

  it('enables answering once started and seals a single choice', () => {
    render(<QuestionPreview />);
    act(startTimer);
    const primary = screen.getByRole('button', { name: /primary key/i });
    expect(primary).toBeEnabled();
    expect(
      screen.getByText(/your choice stays sealed until the debrief/i),
    ).toBeInTheDocument();

    fireEvent.click(primary);
    expect(primary).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/^Selected$/)).toBeInTheDocument();
    expect(
      screen.getByText(/choice recorded for this preview\. no feedback yet/i),
    ).toBeInTheDocument();

    // A second selection cannot replace the sealed one.
    const foreign = screen.getByRole('button', { name: /foreign key/i });
    expect(foreign).toBeDisabled();
    fireEvent.click(foreign);
    expect(foreign).toHaveAttribute('aria-pressed', 'false');
  });

  it('expires with no answer when the twelve seconds elapse', () => {
    render(<QuestionPreview />);
    act(startTimer);
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(
      screen.getByText(/time.s up\. no answer recorded/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('0');
    // Nothing was selected.
    for (const label of ['Primary key', 'Foreign key']) {
      expect(
        screen.getByRole('button', { name: new RegExp(label, 'i') }),
      ).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('lets the learner retry after expiry', () => {
    render(<QuestionPreview />);
    act(startTimer);
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(
      screen.getByText(/your choice stays sealed until the debrief/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('12');
  });

  it('never renders answer-key metadata', () => {
    const { container } = render(<QuestionPreview />);
    act(startTimer);
    fireEvent.click(screen.getByRole('button', { name: /primary key/i }));
    expect(container.innerHTML).not.toMatch(
      /is_correct|correct_option|explanation|misconception/i,
    );
  });
});
