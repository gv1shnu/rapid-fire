// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstructorState,
  SessionReport,
  RoundReport,
} from '../src/instructor-api';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  listener: null as
    null | ((_event: string, session: { user: { id: string } } | null) => void),
}));
vi.mock('../src/instructor-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/instructor-api')>()),
  instructorRpc: h.rpc,
  supabase: {
    auth: {
      onAuthStateChange: (f: typeof h.listener) => {
        h.listener = f;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));
import { Instructor } from '../src/Instructor';
import { parseSessionReport, parseRoundReport } from '../src/instructor-api';
const sid = '00000000-0000-0000-0000-000000000099';
const pid = '00000000-0000-0000-0000-000000000002';
const summary = {
  submitted_students: 1,
  average_score: 300,
  average_correct_count: 3,
  average_wrong_count: 1,
  average_timeout_count: 1,
  average_answer_seconds: 4,
  average_accuracy_percent: 60,
  students_with_under_half_answers: 1,
  answers_under_half_time: 2,
};
const metrics = {
  correct_count: 3,
  wrong_count: 1,
  timeout_count: 1,
  total_answer_seconds: 20,
  average_answer_seconds: 4,
  accuracy_percent: 60,
  answers_under_half_time: 2,
};
const report: SessionReport = {
  session_id: sid,
  question_count: 5,
  summary: { ...summary, students_joined: 2, average_total_answer_seconds: 20 },
  students: [
    {
      ...metrics,
      rank: 1,
      player_id: pid,
      nickname: 'Explorer',
      name: 'Ada Lovelace',
      total_points: 300,
      best_streak: 2,
      rounds_completed: 1,
    },
  ],
};
const roundReport: RoundReport = {
  session_id: sid,
  round_id: 1,
  half_time_seconds: 6,
  summary: {
    ...summary,
    incomplete_students: 0,
    average_round_answer_seconds: 20,
  },
  students: [
    {
      ...metrics,
      player_id: pid,
      nickname: 'Explorer',
      score: 300,
      submitted_at: '2026-09-13T10:00:00Z',
    },
  ],
  questions: [
    {
      question_id: 10,
      submitted_students: 1,
      correct_count: 1,
      wrong_count: 0,
      timeout_count: 0,
      average_answer_seconds: 3,
      accuracy_percent: 100,
      students_under_half_time: 1,
    },
  ],
};
let state: InstructorState;
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount() {
  render(<Instructor />);
  await act(async () => {
    h.listener?.('SIGNED_IN', { user: { id: 'host' } });
  });
  await advance();
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  sessionStorage.setItem('lost-schema-host-session', sid);
  state = {
    rounds: [{ id: 1, title: 'The Vault of Keys', available_questions: 45 }],
    min_available: 9,
    sections: ['A'],
    session: {
      id: sid,
      code: 'ABCDEF',
      status: 'closed',
      closes_at: new Date(Date.now() + 60000).toISOString(),
    },
    config: {
      question_count: 5,
      seconds_per_question: 12,
      duration_seconds: 60,
      tempters: true,
    },
    students_joined: 2,
    students_done: 1,
    server_now: new Date().toISOString(),
  };
  h.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === 'instructor_state') return { ...state };
    if (name === 'session_report') return structuredClone(report);
    if (name === 'round_report') return structuredClone(roundReport);
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
});
describe('instructor closed-session analytics', () => {
  it('renders final standings and summary once, independently of state polling', async () => {
    await mount();
    expect(screen.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    const standings = screen.getByRole('region', { name: 'Session standings' });
    expect(within(standings).getByText('Ada Lovelace')).toBeVisible();
    expect(within(standings).getByText('60%')).toBeVisible();
    expect(within(standings).getByText('3 / 1 / 1')).toBeVisible();
    expect(screen.getByText('Average points').closest('div')).toHaveTextContent(
      '300',
    );
    await advance(9500);
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'session_report'),
    ).toHaveLength(1);
    expect(
      h.rpc.mock.calls.some(
        (c) => c[0] === 'round_report' || c[0] === 'session_leaderboard',
      ),
    ).toBe(false);
  });
  it('loads round details on expansion and retains the result after collapse', async () => {
    await mount();
    const detail = screen
      .getByText('Round 1 · The Vault of Keys')
      .closest('details')!;
    fireEvent.click(detail.querySelector('summary')!);
    await advance();
    expect(h.rpc).toHaveBeenCalledWith('round_report', {
      p_session: sid,
      p_round: 1,
    });
    expect(
      screen.getByRole('region', { name: 'Round 1 question stats' }),
    ).toHaveTextContent('100%');
    expect(
      screen.getByRole('region', { name: 'Round 1 student stats' }),
    ).toHaveTextContent('Explorer');
    fireEvent.click(detail.querySelector('summary')!);
    fireEvent.click(detail.querySelector('summary')!);
    await advance();
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'round_report'),
    ).toHaveLength(1);
  });
  it('requests reports only when a live sitting enters the ended state', async () => {
    state.session!.status = 'live';
    await mount();
    expect(h.rpc.mock.calls.some((c) => c[0] === 'session_report')).toBe(false);
    state.session = { ...state.session!, status: 'closed' };
    await advance(3000);
    expect(screen.getByText('Ada Lovelace')).toBeVisible();
    expect(
      h.rpc.mock.calls.filter((c) => c[0] === 'session_report'),
    ).toHaveLength(1);
  });
  it('keeps report validation errors visible across polls and supports retry', async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string) =>
      name === 'session_report'
        ? { ...report, students: [{ name: 'Unvalidated data' }] }
        : base(name),
    );
    await mount();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invalid session report. Please reconnect.',
    );
    expect(screen.queryByText('Unvalidated data')).not.toBeInTheDocument();
    await advance(3000);
    expect(screen.getByRole('alert')).toBeVisible();
    h.rpc.mockImplementation(base);
    fireEvent.click(screen.getByRole('button', { name: 'Retry report' }));
    await advance();
    expect(screen.getByText('Ada Lovelace')).toBeVisible();
  });
  it('shows loading and discards a late response after sign-out', async () => {
    let resolve!: (x: unknown) => void;
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string) =>
      name === 'session_report'
        ? new Promise((r) => {
            resolve = r;
          })
        : base(name),
    );
    await mount();
    expect(screen.getByText('Loading class results…')).toBeVisible();
    await act(async () => {
      h.listener?.('SIGNED_OUT', null);
      resolve(report);
    });
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Leaderboard' }),
    ).not.toBeInTheDocument();
  });
  it('shows unavailable averages for empty reports', async () => {
    const empty = structuredClone(report);
    empty.students = [];
    empty.summary = {
      submitted_students: 0,
      students_joined: 2,
      answers_under_half_time: 0,
      students_with_under_half_answers: 0,
      average_score: null,
      average_correct_count: null,
      average_wrong_count: null,
      average_timeout_count: null,
      average_accuracy_percent: null,
      average_answer_seconds: null,
      average_total_answer_seconds: null,
    };
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string) =>
      name === 'session_report' ? empty : base(name),
    );
    await mount();
    expect(
      screen.getByText('Average accuracy').closest('div'),
    ).toHaveTextContent('—');
    expect(screen.getByText(/No submitted student results/)).toBeVisible();
  });
  it('rejects malformed round details without rendering them', async () => {
    const base = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name: string) =>
      name === 'round_report'
        ? { ...roundReport, questions: [{ question_id: 'unsafe' }] }
        : base(name),
    );
    await mount();
    fireEvent.click(screen.getByText('Round 1 · The Vault of Keys'));
    await advance();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid round report');
    expect(screen.queryByText('unsafe')).not.toBeInTheDocument();
  });
});
describe('report runtime validation', () => {
  it.each([
    null,
    {},
    { ...report, summary: null },
    { ...report, question_count: 0 },
    { ...report, students: [{ ...report.students[0], accuracy_percent: 101 }] },
    {
      ...report,
      students: [{ ...report.students[0], total_answer_seconds: Infinity }],
    },
  ])('rejects invalid session data %#', (data) => {
    expect(() => parseSessionReport(data)).toThrow();
  });
  it('accepts the complete round response and rejects malformed nested summaries', () => {
    expect(parseRoundReport(roundReport)).toEqual(roundReport);
    expect(() =>
      parseRoundReport({
        ...roundReport,
        summary: { ...roundReport.summary, average_score: '300' },
      }),
    ).toThrow();
  });
});
