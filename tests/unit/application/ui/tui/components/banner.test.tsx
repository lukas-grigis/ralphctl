import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Banner, bannerRows, resolveBannerMode } from '@src/application/ui/tui/components/banner.tsx';

const mode = (routeId: string, columns: number, rows: number, userToggle = false): string =>
  resolveBannerMode({ routeId, columns, rows, userToggle });

describe('resolveBannerMode', () => {
  it.each([
    ['home', 80, 24, 'none'],
    ['home', 100, 29, 'none'],
    ['home', 100, 30, 'compact'],
    ['home', 120, 36, 'compact'],
    ['home', 160, 44, 'compact'],
    ['home', 68, 40, 'none'],
    ['home', 69, 30, 'compact'],
    ['home', 99, 50, 'compact'],
    ['home', 100, 45, 'full'],
    ['home', 160, 45, 'full'],
    ['home', 200, 50, 'full'],
    ['settings', 200, 50, 'none'],
  ])('%s @ %ix%i → %s', (routeId, columns, rows, expected) => {
    expect(mode(routeId, columns, rows)).toBe(expected);
  });

  it.each([
    ['home', 160, 45, 'compact'],
    ['home', 120, 36, 'full'],
    ['home', 80, 24, 'compact'],
    ['home', 60, 24, 'none'],
    // The toggle is Work's (`b`); other routes never show the wordmark.
    ['settings', 200, 50, 'none'],
  ])('userToggle steps %s @ %ix%i → %s', (routeId, columns, rows, expected) => {
    expect(mode(routeId, columns, rows, true)).toBe(expected);
  });
});

describe('bannerRows', () => {
  it('budgets each tier', () => {
    expect(bannerRows('none', 80)).toBe(0);
    expect(bannerRows('compact', 120)).toBe(6);
    expect(bannerRows('compact', 80)).toBe(7);
    expect(bannerRows('full', 160)).toBe(12);
  });
});

// eslint-disable-next-line no-control-regex
const COLOUR = /\x1b\[(?:3[0-7]|38|9[0-7])/;

describe('Banner rendering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('compact paints the 6 art rows, with the quote rail and version beside it at 100 columns', () => {
    const { lastFrame, unmount } = render(<Banner mode="compact" />);
    const frame = lastFrame() ?? '';
    expect(frame.split('\n')).toHaveLength(6);
    expect(frame).toContain('┃');
    expect(frame).toMatch(/· v\d/);
    unmount();
  });

  it('NO_COLOR leaves the art uncoloured', () => {
    vi.stubEnv('NO_COLOR', '1');
    for (const m of ['compact', 'full'] as const) {
      const { lastFrame, unmount } = render(<Banner mode={m} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('██████╗');
      expect(frame).not.toMatch(COLOUR);
      unmount();
    }
  });

  it('renders nothing for none', () => {
    const { lastFrame, unmount } = render(<Banner mode="none" />);
    expect(lastFrame()).toBe('');
    unmount();
  });
});

describe('banner.tsx source', () => {
  it('contains no emoji codepoint', () => {
    const src = readFileSync('src/application/ui/tui/components/banner.tsx', 'utf8');
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
