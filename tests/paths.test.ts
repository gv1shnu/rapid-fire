import { describe, it, expect } from 'vitest';
import { route } from '../src/paths';

describe('route', () => {
  it.each([
    ['/', ''],
    ['/instructor', 'instructor'],
    ['/instructor/', 'instructor'],
    ['/index.html', 'index.html'],
    ['/nowhere', 'nowhere'],
  ])('maps %s to %j under the dev base', (pathname, expected) => {
    expect(route(pathname)).toBe(expected);
  });
});
