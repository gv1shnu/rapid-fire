// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App } from '../src/App';

function go(url: string) {
  window.history.pushState({}, '', url);
}

afterEach(() => {
  cleanup();
  go('/');
});

describe('App routing', () => {
  it('shows the waiting screen and the practice link on the home path', () => {
    go('/');
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /no lab is running right now/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /try the first question/i }),
    ).toHaveAttribute('href', '/?preview=question');
  });

  it('never advertises the instructor page to students on the public landing', () => {
    go('/');
    render(<App />);
    expect(
      screen.queryByRole('link', { name: /instructor/i }),
    ).not.toBeInTheDocument();
    // And no link anywhere on the landing points at /instructor.
    for (const link of screen.queryAllByRole('link')) {
      expect(link).not.toHaveAttribute('href', '/instructor');
    }
  });

  it('renders the instructor control room at /instructor', () => {
    go('/instructor');
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /set the pace/i }),
    ).toBeVisible();
    // No live student session exists without Supabase configured.
    expect(screen.getByText(/setup preview/i)).toBeInTheDocument();
  });

  it('renders the single-question practice preview when preview=question', () => {
    go('/?preview=question');
    render(<App />);
    const banner = screen.getByText(/practice preview · not scored/i);
    expect(banner).toBeInTheDocument();
    // The question stays concealed until the learner starts the timer.
    expect(
      screen.getByRole('button', { name: /start timer/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        name: /which key identifies every row/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('does not leak any answer-key vocabulary into the waiting screen markup', () => {
    go('/');
    const { container } = render(<App />);
    const route = within(container).getByRole('complementary', {
      name: /expedition route/i,
    });
    expect(route).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(
      /is_correct|correct_option|explanation|misconception/i,
    );
  });
});
