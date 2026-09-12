// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  signIn: vi.fn(),
  listener: null as null | ((_e: string, s: unknown) => void),
  session: null as unknown,
}));
vi.mock('../src/instructor-api', () => ({
  instructorRpc: h.rpc,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: h.session } }),
      onAuthStateChange: (f: typeof h.listener) => {
        h.listener = f;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithOAuth: h.signIn,
    },
  },
}));
import { Play } from '../src/Play';
import {
  parsePayload,
  parseResult,
  parseState,
  type StudentState,
} from '../src/student-api';
const sid = '00000000-0000-0000-0000-000000000099';
const tokens = [1, 2, 3, 4].map(
  (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
);
const user = { id: 'student-1', email: 'student@example.edu' };
let state: StudentState;
const question = (seq = 1, round = 1) => ({
  session_id: sid,
  round_id: round,
  seq,
  stem: `Question ${round}.${seq}`,
  body: {},
  options: tokens.map((id, i) => ({ id, body: { text: `Choice ${i + 1}` } })),
  served_at: new Date().toISOString(),
  deadline: new Date(Date.now() + 10000).toISOString(),
  server_now: new Date().toISOString(),
  question_count: 2,
  seconds_per_question: 10,
});
const result = () => ({
  round_id: 1,
  total_points: 100,
  best_streak: 1,
  cumulative_points: 100,
  leaderboard_position: 1,
  questions: [
    {
      seq: 1,
      stem: 'Saved question after refresh',
      body: {},
      options: [1, 2, 3, 4].map((id) => ({
        id,
        body: { text: `Saved option ${id}` },
      })),
      chosen_option: 1,
      correct_option: 1,
      explanation: 'Saved explanation',
      points: 100,
    },
  ],
});
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function start() {
  render(<Play code="ABCDEF" />);
  await advance();
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  state = {
    session_id: sid,
    status: 'live',
    current_round: 1,
    release_status: 'live',
    can_start: true,
    submitted: false,
    server_now: new Date().toISOString(),
    results: [],
  };
  h.session = { user };
  h.listener = null;
  h.signIn.mockReset().mockResolvedValue({ error: null });
  h.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === 'join_session') return { session_id: sid };
    if (name === 'student_state') return { ...state };
    if (name === 'start_round') return question();
    if (name === 'submit_answer') return question(2);
    if (name === 'my_result') return result();
    if (name === 'session_leaderboard') return [];
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('student question lifecycle', () => {
  it('shows the first question and its server-anchored timer', async () => {
    await start();
    expect(screen.getByRole('heading', { name: 'Question 1.1' })).toBeVisible();
    expect(screen.getByRole('timer')).toHaveAccessibleName(
      '10 seconds remaining',
    );
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'join_session'),
    ).toHaveLength(1);
    await advance(2600);
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'join_session'),
    ).toHaveLength(1);
  });
  it('ignores wall-clock changes during a question', async () => {
    await start();
    vi.setSystemTime(new Date('2030-01-01'));
    await advance(1000);
    expect(screen.getByRole('timer')).toHaveAccessibleName(
      '9 seconds remaining',
    );
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'submit_answer'),
    ).toHaveLength(0);
  });
  it('submits exactly once at timeout then starts the next question clock', async () => {
    await start();
    await advance(10000);
    expect(h.rpc).toHaveBeenCalledWith('submit_answer', {
      p_session: sid,
      p_round: 1,
      seq: 1,
      option_id: null,
    });
    expect(screen.getByRole('heading', { name: 'Question 1.2' })).toBeVisible();
    expect(screen.getByRole('timer')).toHaveAccessibleName(
      '10 seconds remaining',
    );
    await advance(1000);
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'submit_answer'),
    ).toHaveLength(1);
  });
  it('locks a pending answer, retries the same token, then recovers', async () => {
    let calls = 0;
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) => {
      if (name === 'submit_answer' && calls++ === 0)
        throw new Error('Network offline');
      return base(name, ...args);
    });
    await start();
    fireEvent.click(screen.getByRole('button', { name: /A Choice 1/ }));
    await advance();
    expect(screen.getByRole('alert')).toHaveTextContent('Network offline');
    expect(screen.getByRole('button', { name: /B Choice 2/ })).toBeDisabled();
    expect(screen.queryByText(/Answer recorded/)).not.toBeInTheDocument();
    await advance(2200);
    expect(screen.getByRole('heading', { name: 'Question 1.2' })).toBeVisible();
    const callsMade = h.rpc.mock.calls.filter((c) => c[0] === 'submit_answer');
    expect(callsMade).toHaveLength(2);
    expect(callsMade[0][1]).toEqual(callsMade[1][1]);
  });
  it('backs off failed timeout requests instead of retrying every animation tick', async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) => {
      if (name === 'submit_answer') throw new Error('Network offline');
      return base(name, ...args);
    });
    await start();
    await advance(10000);
    await advance(1900);
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'submit_answer'),
    ).toHaveLength(1);
    await advance(300);
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'submit_answer'),
    ).toHaveLength(2);
  });
  it('clears the current question when the instructor ends the release', async () => {
    await start();
    state.release_status = 'ended';
    state.submitted = true;
    state.results = [];
    await advance(2600);
    expect(
      screen.queryByRole('heading', { name: 'Question 1.1' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Submission received.' }),
    ).toBeVisible();
  });
  it('binds a new question to its new round after advancement', async () => {
    await start();
    state.current_round = 2;
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) =>
      name === 'start_round' ? question(1, 2) : base(name, ...args),
    );
    await advance(2600);
    expect(screen.getByRole('heading', { name: 'Question 2.1' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /A Choice 1/ }));
    await advance();
    expect(h.rpc).toHaveBeenCalledWith(
      'submit_answer',
      expect.objectContaining({ p_round: 2, seq: 1 }),
    );
  });
  it('shows a sealed receipt to early finishers and never requests their keys', async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) =>
      name === 'submit_answer'
        ? {
            round_complete: true,
            round_id: 1,
            server_now: new Date().toISOString(),
          }
        : base(name, ...args),
    );
    await start();
    state.submitted = true;
    fireEvent.click(screen.getByRole('button', { name: /A Choice 1/ }));
    await advance(3000);
    expect(
      screen.getByRole('heading', { name: 'Submission received.' }),
    ).toBeVisible();
    expect(h.rpc.mock.calls.some((c) => c[0] === 'my_result')).toBe(false);
  });
  it('recovers full debrief content on a refreshed closed session', async () => {
    state.status = 'closed';
    state.release_status = 'ended';
    state.submitted = true;
    state.results = [1];
    await start();
    expect(screen.getByText(/Saved question after refresh/)).toBeVisible();
    expect(screen.getByText('Saved explanation')).toBeVisible();
    expect(screen.getByText('Saved option 1')).toBeVisible();
    expect(h.rpc.mock.calls.some((c) => c[0] === 'start_round')).toBe(false);
  });
  it('shows the live leaderboard by real name as soon as the student submits', async () => {
    // Between rounds: submitted, session still live, solutions not yet released.
    state.submitted = true;
    state.release_status = 'ended';
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) =>
      name === 'session_leaderboard'
        ? [
            { rank: 1, name: 'Ada Lovelace', points: 480, is_me: false },
            { rank: 2, name: 'Vishnu Gandarapu', points: 300, is_me: true },
          ]
        : base(name, ...args),
    );
    await start();
    const board = screen.getByRole('region', { name: 'Leaderboard' });
    expect(board).toBeVisible();
    const rows = board.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada Lovelace');
    expect(rows[0]).toHaveTextContent('480');
    const mine = board.querySelector('li.me')!;
    expect(mine).toHaveTextContent('Vishnu Gandarapu');
    expect(mine).toHaveAttribute('aria-current', 'true');
    expect(mine).toHaveTextContent('You');
    // Solutions stay sealed: no round is offered for review mid-fire.
    expect(screen.queryByText(/answers revealed/)).not.toBeInTheDocument();
  });
  it('does not request the leaderboard while the student is still answering', async () => {
    await start();
    await advance(3000);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'session_leaderboard')).toBe(
      false,
    );
  });
  it('does not start a second attempt after refresh of a submitted live round', async () => {
    state.submitted = true;
    await start();
    expect(
      screen.getByRole('heading', { name: 'Submission received.' }),
    ).toBeVisible();
    expect(h.rpc.mock.calls.some((c) => c[0] === 'start_round')).toBe(false);
  });
  it('removes question content immediately on sign-out and ignores late responses', async () => {
    let resolve!: (x: unknown) => void;
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) =>
      name === 'submit_answer'
        ? new Promise((r) => {
            resolve = r;
          })
        : base(name, ...args),
    );
    await start();
    fireEvent.click(screen.getByRole('button', { name: /A Choice 1/ }));
    await advance();
    await act(async () => {
      h.listener?.('SIGNED_OUT', null);
    });
    expect(
      screen.queryByRole('heading', { name: 'Question 1.1' }),
    ).not.toBeInTheDocument();
    await act(async () => {
      resolve(question(2));
    });
    expect(
      screen.queryByRole('heading', { name: 'Question 1.2' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    ).toBeVisible();
  });
  it('uses a canonical OAuth return URL preserving only the join code', async () => {
    h.session = null;
    await start();
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );
    await advance();
    expect(h.signIn).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        scopes: 'openid email profile',
        redirectTo: `${window.location.origin}/?j=ABCDEF`,
      },
    });
  });
  it('reports OAuth errors instead of silently failing', async () => {
    h.session = null;
    h.signIn.mockResolvedValue({ error: new Error('Google unavailable') });
    await start();
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );
    await advance();
    expect(screen.getByRole('alert')).toHaveTextContent('Google unavailable');
  });
  it('fails closed on malformed RPC data', async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string, ...args: unknown[]) =>
      name === 'start_round'
        ? {
            ...question(),
            options: [{ id: 1, body: { text: 'Leaked numeric ID' } }],
          }
        : base(name, ...args),
    );
    await start();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invalid question response',
    );
    expect(screen.queryByText('Leaked numeric ID')).not.toBeInTheDocument();
  });
});
describe('student wire validation', () => {
  it.each([
    null,
    {},
    { ...question(), deadline: 'invalid' },
    { ...question(), options: [] },
    {
      ...question(),
      options: question().options.map((o) => ({ ...o, id: tokens[0] })),
    },
  ])('rejects malformed questions %#', (q) => {
    expect(() => parsePayload(q)).toThrow();
  });
  it('rejects malformed state and result data', () => {
    expect(() => parseState({ ...state, results: 'all' })).toThrow();
    expect(() => parseResult({ ...result(), questions: [{}] })).toThrow();
  });
  it('validates the actual question, receipt, state and debrief shapes', () => {
    expect(parsePayload(question())).toHaveProperty('seq', 1);
    expect(
      parsePayload({
        round_complete: true,
        round_id: 1,
        server_now: new Date().toISOString(),
      }),
    ).toHaveProperty('round_complete', true);
    expect(parseState(state)).toEqual(state);
    expect(parseResult(result())).toEqual(result());
  });
});
