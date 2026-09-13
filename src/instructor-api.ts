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
export type Config = {
  question_count: number;
  seconds_per_question: number;
  duration_seconds: number;
  tempters: boolean;
};
export type InstructorState = {
  rounds: RoundPool[];
  min_available: number;
  sections: string[];
  session: {
    id: string;
    code: string;
    status: string;
    closes_at: string;
  } | null;
  config: Config | null;
  students_joined: number;
  students_done: number;
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

export type ReportMetrics = {
  correct_count: number;
  wrong_count: number;
  timeout_count: number;
  total_answer_seconds: number;
  average_answer_seconds: number;
  accuracy_percent: number;
  answers_under_half_time: number;
};
export type ReportSummary = {
  submitted_students: number;
  average_score: number | null;
  average_correct_count: number | null;
  average_wrong_count: number | null;
  average_timeout_count: number | null;
  average_answer_seconds: number | null;
  average_accuracy_percent: number | null;
  students_with_under_half_answers: number;
  answers_under_half_time: number;
};
export type SessionReport = {
  session_id: string;
  question_count: number | null;
  summary: ReportSummary & {
    students_joined: number;
    average_total_answer_seconds: number | null;
  };
  students: (ReportMetrics & {
    rank: number;
    player_id: string;
    nickname: string;
    name: string;
    total_points: number;
    best_streak: number;
    rounds_completed: number;
  })[];
};
export type RoundReport = {
  session_id: string;
  round_id: number;
  half_time_seconds: number | null;
  summary: ReportSummary & {
    incomplete_students: number;
    average_round_answer_seconds: number | null;
  };
  students: (ReportMetrics & {
    player_id: string;
    nickname: string;
    score: number;
    submitted_at: string;
  })[];
  questions: {
    question_id: number;
    submitted_students: number;
    correct_count: number;
    wrong_count: number;
    timeout_count: number;
    average_answer_seconds: number;
    accuracy_percent: number;
    students_under_half_time: number;
  }[];
};
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const number = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0;
const integer = (x: unknown) => number(x) && Number.isSafeInteger(x);
const positive = (x: unknown) => integer(x) && Number(x) > 0;
const uuid = (x: unknown) =>
  typeof x === 'string' &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(x);
const nullableNumber = (x: unknown) => x === null || number(x);
const percent = (x: unknown) => number(x) && x <= 100;
function reportSummary(
  x: unknown,
): x is ReportSummary & Record<string, unknown> {
  return (
    record(x) &&
    [
      'submitted_students',
      'students_with_under_half_answers',
      'answers_under_half_time',
    ].every((k) => integer(x[k])) &&
    [
      'average_score',
      'average_correct_count',
      'average_wrong_count',
      'average_timeout_count',
      'average_answer_seconds',
    ].every((k) => nullableNumber(x[k])) &&
    (x.average_accuracy_percent === null || percent(x.average_accuracy_percent))
  );
}
function reportMetrics(x: Record<string, unknown>) {
  return (
    [
      'correct_count',
      'wrong_count',
      'timeout_count',
      'answers_under_half_time',
    ].every((k) => integer(x[k])) &&
    number(x.total_answer_seconds) &&
    number(x.average_answer_seconds) &&
    percent(x.accuracy_percent)
  );
}
export function parseSessionReport(x: unknown): SessionReport {
  if (
    !record(x) ||
    !uuid(x.session_id) ||
    !(x.question_count === null || positive(x.question_count)) ||
    !reportSummary(x.summary) ||
    !record(x.summary) ||
    !integer(x.summary.students_joined) ||
    !nullableNumber(x.summary.average_total_answer_seconds) ||
    !Array.isArray(x.students) ||
    !x.students.every(
      (r) =>
        record(r) &&
        reportMetrics(r) &&
        uuid(r.player_id) &&
        typeof r.nickname === 'string' &&
        typeof r.name === 'string' &&
        positive(r.rank) &&
        integer(r.total_points) &&
        integer(r.best_streak) &&
        positive(r.rounds_completed),
    ) ||
    new Set(x.students.map((r) => r.player_id)).size !== x.students.length
  )
    throw new Error('Invalid session report. Please reconnect.');
  return x as SessionReport;
}
export function parseRoundReport(x: unknown): RoundReport {
  if (
    !record(x) ||
    !uuid(x.session_id) ||
    !positive(x.round_id) ||
    !nullableNumber(x.half_time_seconds) ||
    !reportSummary(x.summary) ||
    !record(x.summary) ||
    !integer(x.summary.incomplete_students) ||
    !nullableNumber(x.summary.average_round_answer_seconds) ||
    !Array.isArray(x.students) ||
    !x.students.every(
      (r) =>
        record(r) &&
        reportMetrics(r) &&
        uuid(r.player_id) &&
        typeof r.nickname === 'string' &&
        integer(r.score) &&
        typeof r.submitted_at === 'string' &&
        Number.isFinite(Date.parse(r.submitted_at)),
    ) ||
    !Array.isArray(x.questions) ||
    !x.questions.every(
      (q) =>
        record(q) &&
        positive(q.question_id) &&
        [
          'submitted_students',
          'correct_count',
          'wrong_count',
          'timeout_count',
          'students_under_half_time',
        ].every((k) => integer(q[k])) &&
        number(q.average_answer_seconds) &&
        percent(q.accuracy_percent),
    )
  )
    throw new Error('Invalid round report. Please reconnect.');
  return x as RoundReport;
}
