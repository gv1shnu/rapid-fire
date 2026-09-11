import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase = url && key ? createClient(url, key) : null;

export type RoundPool = {
  id: number;
  title: string;
  available_questions: number;
};
export type Release = {
  round_id: number;
  question_count: number;
  seconds_per_question: number;
  duration_seconds: number;
  status: 'draft' | 'live' | 'ended';
  started_at: string | null;
  closes_at: string | null;
  ended_at: string | null;
  submitted_students?: number;
};
export type InstructorState = {
  rounds: RoundPool[];
  sections: string[];
  session: {
    id: string;
    code: string;
    current_round: number | null;
    status: string;
    closes_at: string;
  } | null;
  release: Release | null;
  server_now: string;
};

export async function instructorRpc<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!supabase) throw new Error('A Supabase connection is required.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// Public preview counts only; never import the question seed or its answer keys.
export const previewPools: RoundPool[] = [
  { id: 1, title: 'The Vault of Keys', available_questions: 45 },
  { id: 2, title: 'Guild City', available_questions: 45 },
  { id: 3, title: 'The Cipher Lock', available_questions: 0 },
  { id: 4, title: 'The Alchemist’s Workshop', available_questions: 0 },
  { id: 5, title: 'The Card Table', available_questions: 0 },
  { id: 6, title: 'Orbit Grand Prix', available_questions: 0 },
  { id: 7, title: 'The Nesting Temple', available_questions: 0 },
  { id: 8, title: 'Noir Bureau', available_questions: 0 },
  { id: 9, title: 'The Cartographer’s Finale', available_questions: 0 },
];
