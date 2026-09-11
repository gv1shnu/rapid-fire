import { describe, expect, it } from 'vitest';
import { instructorRpc, previewPools, supabase } from '../src/instructor-api';

describe('instructor-api preview catalogue', () => {
  it('exposes exactly nine rounds numbered 1..9', () => {
    expect(previewPools).toHaveLength(9);
    expect(previewPools.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(previewPools.every((p) => p.title.length > 0)).toBe(true);
  });

  it('advertises seeded counts only for the two development pools', () => {
    const seeded = previewPools.filter((p) => p.available_questions > 0);
    expect(seeded.map((p) => p.id)).toEqual([1, 2]);
    expect(seeded.every((p) => p.available_questions === 45)).toBe(true);
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
});
