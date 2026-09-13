import { instructorRpc } from './instructor-api';

export type Body = {
  text?: string;
  code_html?: string;
  table_json?: { cols: string[]; rows: (string | number | boolean | null)[][] };
};
export type Question = {
  session_id: string;
  round_id: number;
  seq: number;
  stem: string;
  body: Body;
  options: { id: string; body: Body }[];
  tempt_options?: string[];
  served_at: string;
  deadline: string;
  server_now: string;
  question_count: number;
  seconds_per_question: number;
};
export type Payload =
  Question | { round_complete: true; round_id: number; server_now: string };
export type StudentState = {
  session_id: string;
  status: 'lobby' | 'live' | 'closed';
  // The player's own next/in-progress round (lowest unsubmitted), null when done.
  current_round: number | null;
  done: boolean;
  can_start: boolean;
  server_now: string;
  results: number[];
};
export type Result = {
  round_id: number;
  total_points: number;
  best_streak: number;
  cumulative_points: number;
  leaderboard_position: number;
  questions: {
    seq: number;
    stem: string;
    body: Body;
    options: { id: number; body: Body }[];
    chosen_option: number | null;
    correct_option: number;
    explanation: string;
    points: number;
  }[];
};
export type LeaderboardRow = {
  name: string;
  points: number;
  rank: number;
  is_me: boolean;
};
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const timestamp = (x: unknown) =>
  typeof x === 'string' && Number.isFinite(Date.parse(x));
const integer = (x: unknown) => Number.isInteger(x) && Number(x) > 0;
function body(x: unknown): boolean {
  if (!record(x)) return false;
  if (x.text !== undefined && typeof x.text !== 'string') return false;
  if (x.code_html !== undefined && typeof x.code_html !== 'string')
    return false;
  if (x.table_json !== undefined) {
    const t = x.table_json;
    if (
      !record(t) ||
      !Array.isArray(t.cols) ||
      !t.cols.every((c) => typeof c === 'string') ||
      !Array.isArray(t.rows) ||
      !t.rows.every(
        (r) =>
          Array.isArray(r) &&
          r.every(
            (c) =>
              c === null || ['string', 'number', 'boolean'].includes(typeof c),
          ),
      )
    )
      return false;
  }
  return true;
}
export function parsePayload(x: unknown): Payload {
  if (!record(x) || !integer(x.round_id) || !timestamp(x.server_now))
    throw new Error('Invalid question response. Please reconnect.');
  if (x.round_complete === true) return x as Payload;
  if (
    typeof x.session_id !== 'string' ||
    !integer(x.seq) ||
    !integer(x.question_count) ||
    !integer(x.seconds_per_question) ||
    typeof x.stem !== 'string' ||
    !body(x.body) ||
    !timestamp(x.served_at) ||
    !timestamp(x.deadline) ||
    !Array.isArray(x.options) ||
    x.options.length !== 4 ||
    !x.options.every(
      (o) =>
        record(o) &&
        typeof o.id === 'string' &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
          o.id,
        ) &&
        body(o.body),
    ) ||
    new Set(x.options.map((o) => o.id)).size !== 4
  )
    throw new Error('Invalid question response. Please reconnect.');
  if (
    x.tempt_options !== undefined &&
    (!Array.isArray(x.tempt_options) ||
      x.tempt_options.length !== 2 ||
      new Set(x.tempt_options).size !== 2 ||
      !x.tempt_options.every(
        (token) =>
          typeof token === 'string' &&
          (x.options as Question['options']).some((o) => o.id === token),
      ))
  )
    throw new Error('Invalid question response. Please reconnect.');
  return x as Question;
}
export function parseState(x: unknown): StudentState {
  if (
    !record(x) ||
    typeof x.session_id !== 'string' ||
    !['lobby', 'live', 'closed'].includes(String(x.status)) ||
    (x.current_round !== null && !integer(x.current_round)) ||
    typeof x.done !== 'boolean' ||
    typeof x.can_start !== 'boolean' ||
    !timestamp(x.server_now) ||
    !Array.isArray(x.results) ||
    !x.results.every(integer)
  )
    throw new Error('Invalid session response. Please reconnect.');
  return x as StudentState;
}
export function parseResult(x: unknown): Result {
  if (
    !record(x) ||
    !integer(x.round_id) ||
    ![
      'total_points',
      'best_streak',
      'cumulative_points',
      'leaderboard_position',
    ].every(
      (k) =>
        typeof x[k] === 'number' && Number.isFinite(x[k]) && Number(x[k]) >= 0,
    ) ||
    !Array.isArray(x.questions) ||
    !x.questions.every(
      (q) =>
        record(q) &&
        integer(q.seq) &&
        typeof q.stem === 'string' &&
        body(q.body) &&
        typeof q.explanation === 'string' &&
        integer(q.correct_option) &&
        (q.chosen_option === null || integer(q.chosen_option)) &&
        typeof q.points === 'number' &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((o) => record(o) && integer(o.id) && body(o.body)),
    )
  )
    throw new Error('Invalid result response. Please reconnect.');
  return x as Result;
}
export function parseLeaderboard(x: unknown): LeaderboardRow[] {
  if (
    !Array.isArray(x) ||
    !x.every(
      (r) =>
        record(r) &&
        typeof r.name === 'string' &&
        typeof r.points === 'number' &&
        Number.isFinite(r.points) &&
        integer(r.rank) &&
        typeof r.is_me === 'boolean',
    )
  )
    throw new Error('Invalid leaderboard response. Please reconnect.');
  return x as LeaderboardRow[];
}
export async function studentRpc<T>(
  name: string,
  args: Record<string, unknown>,
  parse: (x: unknown) => T,
): Promise<T> {
  return parse(await instructorRpc<unknown>(name, args));
}
