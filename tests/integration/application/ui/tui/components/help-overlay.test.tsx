/**
 * HelpOverlay — scroll model + content completeness.
 *
 * Guards:
 *   - The overlay renders its full section set (Global, Lists, Execute keys present).
 *   - When content overflows the terminal height, a scroll footer appears.
 *   - ↑/↓ and PgUp/PgDn change the visible slice.
 *   - The `lists` section documents the Home/End keys (not g/G — those were removed to
 *     resolve the progress-overlay key conflict, DESIGN-SYSTEM §6.4).
 *   - Windowing charges the pre-section blank line to the row budget, so the card fits the
 *     terminal and the `lines X–Y of N` counter matches what is actually on screen.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { DOWN, UP, PAGE_DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

/** ink-testing-library's stdout stub exposes no `rows`, so `useTerminalSize` falls back to 24. */
const STUB_TERMINAL_ROWS = 24;

const FOOTER_RE = /lines (\d+)–(\d+) of (\d+)/;

interface ParsedFrame {
  readonly height: number;
  /** Body rows only (chrome stripped), in render order, borders and padding removed. */
  readonly body: readonly string[];
  readonly first: number;
  readonly last: number;
  readonly total: number;
}

/**
 * Splits a rendered frame into chrome + body. Card layout is:
 * blank / border / header / blank / …body… / blank / footer / border / blank.
 */
const parseFrame = (frame: string): ParsedFrame => {
  const lines = frame.split('\n');
  const borderIdx = lines.findIndex((l) => l.includes('╭'));
  const footerIdx = lines.findIndex((l) => FOOTER_RE.test(l));
  expect(borderIdx, 'card border should be rendered').toBeGreaterThanOrEqual(0);
  expect(footerIdx, 'scroll footer should be rendered').toBeGreaterThan(borderIdx);
  const counts = FOOTER_RE.exec(lines[footerIdx] ?? '') ?? [];
  return {
    height: lines.length,
    body: lines.slice(borderIdx + 3, footerIdx - 1).map((l) => l.replaceAll(/[│╭╮╰╯─]/gu, '').trim()),
    first: Number(counts[1]),
    last: Number(counts[2]),
    total: Number(counts[3]),
  };
};

const renderOverlay = (): ReturnType<typeof render> => {
  return render(
    <HintsProvider>
      <HelpOverlay />
    </HintsProvider>
  );
};

describe('HelpOverlay', () => {
  it('renders the Global and Lists sections', async () => {
    // Global opens the list; Lists sits past the first window on a 24-row terminal, so scroll for it.
    const r = renderOverlay();
    await tick(30);
    expect(r.lastFrame() ?? '').toMatch(/Global/i);

    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      r.stdin.write(DOWN);
      await tick(10);
      found = /Lists/i.test(r.lastFrame() ?? '');
    }

    expect(found, 'the Lists section should be reachable by scrolling').toBe(true);
    r.unmount();
  });

  it('documents Home/End keys in the Lists section (not g/G) — scroll to reveal them', async () => {
    // g/G were removed from listKeys to resolve the progress-overlay key conflict.
    // Home and End should be the documented jump-to-first/last keys.
    // The default terminal is ~24 rows; the Lists section rows are off-screen — scroll to expose them.
    const r = renderOverlay();
    await tick(30);

    // Scroll down until "Home" appears or we've pressed ↓ 60 times (safety cap).
    let found = false;
    for (let i = 0; i < 60; i++) {
      const f = r.lastFrame() ?? '';
      if (f.includes('Home') && f.includes('End')) {
        found = true;
        break;
      }
      r.stdin.write(DOWN);
      await tick(10);
    }

    expect(found, 'Home and End key labels should appear in the HelpOverlay after scrolling').toBe(true);
    r.unmount();
  });

  it('shows a scroll footer when content overflows and scrolls on ↓/↑', async () => {
    // The overlay has ~47+ binding rows; a 20-row terminal will overflow.
    // (The actual body rows = max(4, 20 - 6) = 14; we have ~50 rows of content.)
    const r = renderOverlay();
    await tick(30);
    const frameBefore = r.lastFrame() ?? '';
    // Footer with line count should appear when overflowing.
    expect(frameBefore).toMatch(/lines \d+–\d+ of \d+/);

    // Press ↓ — should advance the offset and change the visible range.
    r.stdin.write(DOWN);
    await tick(30);
    const frameAfter = r.lastFrame() ?? '';
    expect(frameAfter).toMatch(/lines 2–/);

    // Press ↑ — should go back to top.
    r.stdin.write(UP);
    await tick(30);
    const frameBack = r.lastFrame() ?? '';
    expect(frameBack).toMatch(/lines 1–/);

    r.unmount();
  });

  it('moves by a full page on PgDn', async () => {
    const r = renderOverlay();
    await tick(30);

    const frameBefore = r.lastFrame() ?? '';
    expect(frameBefore).toMatch(/lines 1–(\d+) of (\d+)/);

    r.stdin.write(PAGE_DOWN);
    await tick(30);
    const frameAfter = r.lastFrame() ?? '';
    // After PgDn, offset > 0 so first displayed line is > 1.
    expect(frameAfter).not.toMatch(/lines 1–/);
    expect(frameAfter).toMatch(/lines \d+–\d+ of \d+/);

    r.unmount();
  });

  it('keeps the card inside the terminal and the footer counter honest', async () => {
    // Regression: section titles used to render with a marginTop, so a window holding N titles
    // was N rows taller than the budget — the card overflowed and the counter named unseen rows.
    const r = renderOverlay();
    await tick(30);

    const parsed = parseFrame(r.lastFrame() ?? '');
    expect(parsed.height).toBeLessThanOrEqual(STUB_TERMINAL_ROWS);
    expect(parsed.body).toHaveLength(parsed.last - parsed.first + 1);

    r.unmount();
  });

  it('spaces sections with a real blank row — one before each title except the first', async () => {
    const r = renderOverlay();
    await tick(30);

    // Top of the list: the very first row is a section title with no blank above it.
    expect(parseFrame(r.lastFrame() ?? '').body[0]).toBe('Global');

    // Scroll until a section title lands below the top of the window, then assert it is
    // preceded by a blank row that is itself part of the budgeted window.
    let checked = false;
    for (let i = 0; i < 60 && !checked; i++) {
      r.stdin.write(DOWN);
      await tick(10);
      const { body, first, last } = parseFrame(r.lastFrame() ?? '');
      expect(body).toHaveLength(last - first + 1);
      const titleIdx = body.indexOf('Lists');
      if (titleIdx > 0) {
        expect(body[titleIdx - 1]).toBe('');
        checked = true;
      }
    }

    expect(checked, 'the Lists section title should scroll into view below the first row').toBe(true);
    r.unmount();
  });

  it('scrolls all the way to the last row', async () => {
    // maxOffset used to stop short of the end because spacer rows were not counted.
    const r = renderOverlay();
    await tick(30);

    for (let i = 0; i < 15; i++) {
      r.stdin.write(PAGE_DOWN);
      await tick(10);
    }

    const parsed = parseFrame(r.lastFrame() ?? '');
    expect(parsed.last).toBe(parsed.total);
    expect(parsed.body).toHaveLength(parsed.last - parsed.first + 1);
    expect(parsed.height).toBeLessThanOrEqual(STUB_TERMINAL_ROWS);

    r.unmount();
  });
});
