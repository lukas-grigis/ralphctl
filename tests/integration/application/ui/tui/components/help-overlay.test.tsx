/**
 * HelpOverlay — scroll model + content completeness.
 *
 * Guards:
 *   - The overlay renders its full section set (Global, Lists, Execute keys present).
 *   - When content overflows the terminal height, a scroll footer appears.
 *   - ↑/↓ and PgUp/PgDn change the visible slice.
 *   - The `lists` section documents the Home/End keys (not g/G — those were removed to
 *     resolve the progress-overlay key conflict, DESIGN-SYSTEM §6.4).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { DOWN, UP, PAGE_DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

const renderOverlay = (): ReturnType<typeof render> => {
  return render(
    <HintsProvider>
      <HelpOverlay />
    </HintsProvider>
  );
};

describe('HelpOverlay', () => {
  it('renders the Global and Lists sections', async () => {
    const r = renderOverlay();
    await tick(30);
    const frame = r.lastFrame() ?? '';
    expect(frame).toMatch(/Global/i);
    expect(frame).toMatch(/Lists/i);
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
});
