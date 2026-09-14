import { describe, expect, it } from 'vitest';
import {
  instructorRpc,
  isClockSkewError,
  parseInstructorSessions,
  previewPools,
  supabase,
} from '../src/instructor-api';

describe('instructor-api preview catalogue', () => {
  it('exposes exactly nine rounds numbered 1..9', () => {
    expect(previewPools).toHaveLength(9);
    expect(previewPools.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(previewPools.every((p) => p.title.length > 0)).toBe(true);
  });

  it('advertises the generated development pool counts', () => {
    const seeded = previewPools.filter((p) => p.available_questions > 0);
    expect(seeded.map((p) => p.available_questions)).toEqual([
      45, 44, 11, 18, 11, 11, 9, 16, 9,
    ]);
  });

  it('carries no answer-key fields in the public catalogue', () => {
    expect(JSON.stringify(previewPools)).not.toMatch(
      /is_correct|correct|explanation|misconception|answer/i,
    );
  });

  it('has no Supabase client without public environment values', () => {
    expect(supabase).toBeNull();
  });

  it('refuses RPC calls when no connection is configured', async () => {
    await expect(instructorRpc('instructor_state')).rejects.toThrow(
      /supabase connection is required/i,
    );
  });

  it('recognises the transient future-iat token error as clock skew', () => {
    for (const message of [
      'JWSError JWTIssuedAtFuture',
      'JWT issued at future',
      'token is not yet valid',
      'token used before issued',
    ]) {
      expect(isClockSkewError(message)).toBe(true);
    }
  });

  it('does not mistake real failures for clock skew', () => {
    for (const message of [
      'JWT expired',
      'invalid claim: missing sub claim',
      'host_only',
      'permission denied for function instructor_state',
    ]) {
      expect(isClockSkewError(message)).toBe(false);
    }
  });

  it('parses a past-sessions list and allows null config on drafts', () => {
    const rows = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'ABCDEF',
        section: 'Section A',
        status: 'closed',
        started_at: '2026-09-13T10:00:00Z',
        closes_at: '2026-09-13T11:00:00Z',
        question_count: 5,
        seconds_per_question: 12,
        students_joined: 20,
        students_done: 18,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        code: 'GHIJKL',
        section: 'Section B',
        status: 'live',
        started_at: '2026-09-13T12:00:00Z',
        closes_at: null,
        question_count: null,
        seconds_per_question: null,
        students_joined: 0,
        students_done: 0,
      },
    ];
    expect(parseInstructorSessions(rows)).toHaveLength(2);
    expect(parseInstructorSessions([])).toEqual([]);
  });

  it('rejects a malformed past-sessions list', () => {
    expect(() =>
      parseInstructorSessions([{ id: 'not-a-uuid', code: 'ABCDEF' }]),
    ).toThrow(/session list/i);
    expect(() => parseInstructorSessions({})).toThrow(/session list/i);
  });
});
