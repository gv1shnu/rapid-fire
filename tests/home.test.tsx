// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

// A controllable fake of the Supabase client + role RPC.
const h = vi.hoisted(() => ({
  session: { value: null as unknown },
  rpc: vi.fn(),
  signInWithOAuth: vi.fn().mockResolvedValue({ error: null }),
  signOut: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../src/instructor-api', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: h.session.value } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signInWithOAuth: h.signInWithOAuth,
      signOut: h.signOut,
    },
  },
  instructorRpc: h.rpc,
}));

import { Home } from '../src/Home';

beforeEach(() => {
  h.session.value = null;
  h.rpc.mockReset();
  h.signInWithOAuth.mockClear();
  h.signOut.mockClear();
});
afterEach(() => cleanup());

describe('Home sign-in and role routing', () => {
  it('offers Google sign-in when signed out and no instructor link is shown', async () => {
    render(<Home />);
    const button = await screen.findByRole('button', {
      name: /sign in with google/i,
    });
    expect(button).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /control room|instructor/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(h.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });

  it('shows a waiting screen for a signed-in student, with no instructor link', async () => {
    h.session.value = { user: { email: 'student@partner.example' } };
    h.rpc.mockRejectedValue(new Error('host_only'));
    render(<Home />);
    expect(
      await screen.findByText(/waiting for the lab to start/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign out/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /control room/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /sign in with google/i }),
    ).not.toBeInTheDocument();
  });

  it('routes a signed-in instructor to the control room', async () => {
    h.session.value = { user: { email: 'instructor1@partner.example' } };
    h.rpc.mockResolvedValue({ rounds: [], sections: [], release: null });
    render(<Home />);
    const link = await screen.findByRole('link', {
      name: /open the control room/i,
    });
    expect(link).toHaveAttribute('href', '/instructor');
    expect(
      screen.getByRole('button', { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it('signs out back to the sign-in state', async () => {
    h.session.value = { user: { email: 'student@partner.example' } };
    h.rpc.mockRejectedValue(new Error('host_only'));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    expect(
      await screen.findByRole('button', { name: /sign in with google/i }),
    ).toBeInTheDocument();
  });
});
