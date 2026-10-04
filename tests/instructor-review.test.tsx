// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/instructor-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/instructor-api')>()),
  supabase: {
    auth: {
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        cb('SIGNED_IN', { user: { id: 'host' } });
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithOAuth: vi.fn(),
    },
  },
  instructorRpc: h.rpc,
}));

import { Instructor } from '../src/Instructor';

const SESSION = '11111111-1111-4111-8111-111111111111';
const option = (id: number, text: string, is_correct = false) => ({
  id,
  body: { text },
  is_correct,
});
function question(id: number, stem: string, edited = false) {
  return {
    question_id: id,
    stem,
    display_type: 'concept',
    body: null,
    explanation: `Because of ${id}.`,
    edited,
    options: [
      option(id * 10 + 1, 'Foreign key'),
      option(id * 10 + 2, 'Primary key', true),
      option(id * 10 + 3, 'Default value'),
      option(id * 10 + 4, 'Null'),
    ],
  };
}
function review(first = question(1, 'Which key identifies every row?')) {
  return {
    config: { question_count: 1, seconds_per_question: 12, tempters: true },
    rounds: [
      { id: 1, title: 'The Vault of Keys', available: 9, questions: [first] },
      // A pool exactly the size of the draw has nothing to swap in.
      {
        id: 2,
        title: 'Guild City',
        available: 1,
        questions: [question(2, 'DDL?')],
      },
    ],
  };
}

// A minimal fake of the instructor RPC surface.
let server: {
  started: boolean;
  draft: boolean;
  review: ReturnType<typeof review>;
};
function state() {
  return {
    rounds: [
      { id: 1, title: 'The Vault of Keys', available_questions: 9 },
      { id: 2, title: 'Guild City', available_questions: 1 },
    ],
    min_available: 1,
    sections: ['A'],
    session: {
      id: SESSION,
      code: 'ABCDEF',
      status: server.started ? 'live' : 'lobby',
      closes_at: new Date(Date.now() + 3600000).toISOString(),
    },
    config: server.started
      ? {
          question_count: 1,
          seconds_per_question: 12,
          duration_seconds: 12,
          tempters: true,
        }
      : null,
    draft: server.draft && !server.started ? review().config : null,
    students_joined: 0,
    students_done: 0,
    server_now: new Date().toISOString(),
  };
}
beforeEach(() => {
  sessionStorage.clear();
  server = { started: false, draft: false, review: review() };
  h.rpc.mockReset();
  h.rpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      switch (name) {
        case 'instructor_state':
          return args.p_session
            ? state()
            : { ...state(), session: null, config: null, draft: null };
        case 'instructor_sessions':
          return [];
        case 'open_session':
          return { session_id: SESSION, code: 'ABCDEF' };
        case 'prepare_rapid_fire':
        case 'draft_review':
          server.draft = true;
          return server.review;
        case 'edit_draft_question':
          server.review = review({ ...question(1, String(args.p_stem), true) });
          return server.review;
        case 'swap_draft_question':
          throw new Error('no_replacement');
        case 'start_rapid_fire':
          server.started = true;
          return null;
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

async function openReview() {
  render(<Instructor />);
  fireEvent.change(await screen.findByLabelText(/student section/i), {
    target: { value: 'A' },
  });
  fireEvent.change(screen.getByLabelText(/questions per round/i), {
    target: { value: '1' },
  });
  fireEvent.click(screen.getByRole('button', { name: /review questions/i }));
  return screen.findByRole('region', { name: /review the questions/i });
}

describe('Instructor question review', () => {
  it('shows every drawn question with its answer before the join link exists', async () => {
    const panel = await openReview();
    expect(
      within(panel).getByText('Which key identifies every row?'),
    ).toBeVisible();
    const correct = within(panel)
      .getAllByText(/correct answer/i)[0]
      .closest('li')!;
    expect(correct).toHaveTextContent('Primary key');
    expect(screen.queryByText(/share this link/i)).not.toBeInTheDocument();
    expect(h.rpc).toHaveBeenCalledWith('prepare_rapid_fire', {
      p_session: SESSION,
      p_count: 1,
      p_seconds: 12,
      p_tempters: true,
    });

    fireEvent.click(screen.getByRole('button', { name: /approve & start/i }));
    expect(await screen.findByText(/share this link/i)).toBeVisible();
    expect(screen.getByText(/\?j=ABCDEF/)).toBeVisible();
    expect(
      screen.queryByRole('region', { name: /review the questions/i }),
    ).not.toBeInTheDocument();
  });

  it('edits wording and the correct answer for this rapid fire', async () => {
    const panel = await openReview();
    const first = within(panel)
      .getByText('Which key identifies every row?')
      .closest('li')!;
    fireEvent.click(within(first).getByRole('button', { name: /^edit$/i }));
    fireEvent.change(within(first).getByLabelText(/^question$/i), {
      target: { value: 'Which key is unique?' },
    });
    fireEvent.click(within(first).getByLabelText(/option a is correct/i));
    fireEvent.click(
      within(first).getByRole('button', { name: /save question/i }),
    );
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('edit_draft_question', {
        p_session: SESSION,
        p_round: 1,
        p_question: 1,
        p_stem: 'Which key is unique?',
        p_options: [
          { id: 11, text: 'Foreign key' },
          { id: 12, text: 'Primary key' },
          { id: 13, text: 'Default value' },
          { id: 14, text: 'Null' },
        ],
        p_correct: 11,
        p_explanation: 'Because of 1.',
      }),
    );
    expect(
      await within(panel).findByText('Which key is unique?'),
    ).toBeVisible();
    expect(within(panel).getByText('EDITED')).toBeVisible();
  });

  it('blocks saving an empty field and swapping from an exhausted pool', async () => {
    const panel = await openReview();
    const second = within(panel).getByText('DDL?').closest('li')!;
    expect(
      within(second).getByRole('button', { name: /swap for another/i }),
    ).toBeDisabled();
    const first = within(panel)
      .getByText('Which key identifies every row?')
      .closest('li')!;
    fireEvent.click(within(first).getByRole('button', { name: /^edit$/i }));
    fireEvent.change(within(first).getByLabelText(/option b text/i), {
      target: { value: ' ' },
    });
    expect(
      within(first).getByRole('button', { name: /save question/i }),
    ).toBeDisabled();
  });

  it('explains a failed swap in plain words', async () => {
    const panel = await openReview();
    const first = within(panel)
      .getByText('Which key identifies every row?')
      .closest('li')!;
    fireEvent.click(
      within(first).getByRole('button', { name: /swap for another/i }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /nothing to swap in/i,
    );
  });

  it('reopens an unstarted draft after a reload', async () => {
    sessionStorage.setItem('lost-schema-host-session', SESSION);
    server.draft = true;
    render(<Instructor />);
    const panel = await screen.findByRole('region', {
      name: /review the questions/i,
    });
    expect(
      within(panel).getByText('Which key identifies every row?'),
    ).toBeVisible();
    expect(screen.getByLabelText(/questions per round/i)).toHaveValue(1);
    expect(
      screen.getByRole('button', { name: /approve & start/i }),
    ).toBeEnabled();
  });
});
