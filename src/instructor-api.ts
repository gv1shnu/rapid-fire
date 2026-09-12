import { createClient } from '@supabase/supabase-js';
import catalogue from './question-catalogue.json';
import { assertPublicKey } from './public-config';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
assertPublicKey(key);
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
  admission_closes_at?: string | null;
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
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  let result;
  try {
    result = await supabase.rpc(name, args).abortSignal(controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
  const { data, error } = result;
  if (error) throw new Error(error.message);
  if (data && typeof data === 'object' && typeof data.error === 'string')
    throw new Error(data.error);
  return data as T;
}

// Public preview counts only; never import the question seed or its answer keys.
export const previewPools: RoundPool[] = catalogue;
