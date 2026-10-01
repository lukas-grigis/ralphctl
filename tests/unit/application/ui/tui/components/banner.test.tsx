import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveBannerMode } from '@src/application/ui/tui/components/banner.tsx';

const mode = (routeId: string, columns: number, rows: number, userToggle = false): string =>
  resolveBannerMode({ routeId, columns, rows, userToggle });

describe('resolveBannerMode', () => {
  it.each([
    ['home', 100, 40, 'full'],
    ['home', 160, 36, 'compact'],
    ['home', 99, 50, 'compact'],
    ['settings', 200, 50, 'compact'],
  ])('%s @ %ix%i → %s', (routeId, columns, rows, expected) => {
    expect(mode(routeId, columns, rows)).toBe(expected);
  });

  it.each([
    ['home', 100, 40, 'compact'],
    ['home', 160, 36, 'full'],
    ['home', 99, 50, 'full'],
    // The toggle is Home's (`b`); other routes never show the wordmark.
    ['settings', 200, 50, 'compact'],
  ])('userToggle flips %s @ %ix%i → %s', (routeId, columns, rows, expected) => {
    expect(mode(routeId, columns, rows, true)).toBe(expected);
  });
});

describe('banner.tsx source', () => {
  it('contains no emoji codepoint', () => {
    const src = readFileSync('src/application/ui/tui/components/banner.tsx', 'utf8');
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
