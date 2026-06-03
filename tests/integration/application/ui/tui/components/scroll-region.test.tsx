/**
 * ScrollRegion mouse-tracking gate. The component enables xterm SGR mouse tracking on mount
 * (so wheel events scroll the viewport), but must withdraw the enable sequence whenever a
 * prompt holds input — otherwise wheel bytes (`\x1b[<64;X;YM`) leak through ink's input
 * parser to whichever `useInput` handler is active and end up inserted into text prompts as
 * stray `M` / `;` / digit characters.
 *
 * Ink-testing-library's stdout does not expose `isTTY`, so we drive `ink.render` directly
 * with a minimal stdout / stdin pair that satisfies the component's TTY guard and lets us
 * inspect the written escape sequences.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render as inkRender, Box, Text } from 'ink';
import { render as itlRender } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';

const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';

// VT220 paging + arrow byte sequences ink parses into key.{pageUp,pageDown,upArrow,downArrow}.
const DOWN = `${String.fromCharCode(27)}[B`;
const UP = `${String.fromCharCode(27)}[A`;
const PAGE_DOWN = `${String.fromCharCode(27)}[6~`;
const PAGE_UP = `${String.fromCharCode(27)}[5~`;
// A single wheel-down notch in xterm SGR mouse-tracking encoding (button 65 = wheel-down).
const WHEEL_DOWN = `${String.fromCharCode(27)}[<65;10;10M`;

class FakeStdout extends EventEmitter {
  public columns = 80;
  public rows = 24;
  public readonly isTTY = true;
  public readonly writes: string[] = [];
  write = (chunk: string): boolean => {
    this.writes.push(chunk);
    return true;
  };
}

class FakeStdin extends EventEmitter {
  public readonly isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

const renderScroll = (
  disabled: boolean
): { stdout: FakeStdout; stdin: FakeStdin; rerender: (d: boolean) => void; unmount: () => void } => {
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = inkRender(
    <ScrollRegion disabled={disabled}>
      <Text>content</Text>
    </ScrollRegion>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );
  return {
    stdout,
    stdin,
    rerender: (d: boolean): void => {
      instance.rerender(
        <ScrollRegion disabled={d}>
          <Text>content</Text>
        </ScrollRegion>
      );
    },
    unmount: instance.unmount,
  };
};

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Distinct sentinel rows so the visible window of a clipped viewport is identifiable in the
 * rendered frame. The ScrollRegion is wrapped in a fixed-`height` box (`VIEWPORT_H`) so its
 * `flexGrow={1}` viewport measures shorter than the content — `maxOffset > 0` and scrolling is
 * meaningful. (A bare ScrollRegion in the test renderer measures its viewport at the full
 * content height, so nothing ever overflows.)
 */
const ROW_COUNT = 40;
const VIEWPORT_H = 10;
const ROW = (i: number): string => `row-${String(i).padStart(2, '0')}-sentinel`;

const TallContent = (suppressArrows: boolean): React.JSX.Element => (
  <Box height={VIEWPORT_H} flexDirection="column">
    <ScrollRegion suppressArrows={suppressArrows}>
      <Box flexDirection="column">
        {Array.from({ length: ROW_COUNT }, (_, i) => (
          <Text key={i}>{ROW(i)}</Text>
        ))}
      </Box>
    </ScrollRegion>
  </Box>
);

/**
 * Render the tall ScrollRegion through ink-testing-library, which honours the fixed wrapper
 * height and clips overflow — so `↑/↓/PgUp/PgDn` keystrokes (written via `stdin.write`) are
 * parsed by ink and the clipped window in `lastFrame()` reflects the live scroll offset.
 * (This renderer's stdout has no `isTTY`, so mouse-wheel tracking is never enabled here — the
 * wheel case uses the FakeStdout TTY path below.)
 */
const renderTallKeys = (
  suppressArrows: boolean
): { stdin: { write: (d: string) => void }; currentFrame: () => string; unmount: () => void } => {
  const r = itlRender(TallContent(suppressArrows));
  return {
    stdin: r.stdin,
    currentFrame: (): string => r.lastFrame() ?? '',
    unmount: r.unmount,
  };
};

/**
 * Render the tall ScrollRegion into a fake 24-row TTY (so mouse-wheel tracking is enabled).
 * `debug: true` makes ink write the full rendered frame to stdout on every render;
 * `currentFrame()` returns the latest write carrying content, from which the visible window is
 * read. Wheel notches are delivered as raw bytes on the FakeStdin and handled by the component's
 * own SGR `data` listener — entirely outside `useInput`, hence unaffected by `suppressArrows`.
 */
const renderTallTty = (
  suppressArrows: boolean
): { stdin: FakeStdin; currentFrame: () => string; unmount: () => void } => {
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = inkRender(TallContent(suppressArrows), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    currentFrame: (): string => {
      for (let i = stdout.writes.length - 1; i >= 0; i--) {
        if (stdout.writes[i]?.includes('sentinel')) return stdout.writes[i] ?? '';
      }
      return '';
    },
    unmount: instance.unmount,
  };
};

/**
 * Lowest sentinel index visible in a frame. The inner box shifts up by `marginTop=-offset` and
 * the viewport clips the overflow, so the topmost visible row's index equals the current scroll
 * offset — a proxy for the offset that survives the rendered-frame round-trip.
 */
const topVisibleRow = (frame: string): number => {
  for (let i = 0; i < ROW_COUNT; i++) {
    if (frame.includes(ROW(i))) return i;
  }
  return -1;
};

describe('ScrollRegion mouse-tracking gate', () => {
  it('writes the SGR-mouse enable sequence on mount when not disabled', async () => {
    const r = renderScroll(false);
    await tick();
    expect(r.stdout.writes.some((w) => w.includes(ENABLE))).toBe(true);
    r.unmount();
  });

  it('does NOT write the enable sequence on mount when disabled', async () => {
    const r = renderScroll(true);
    await tick();
    expect(r.stdout.writes.some((w) => w.includes(ENABLE))).toBe(false);
    r.unmount();
  });

  it('writes the disable sequence when `disabled` flips from false to true', async () => {
    const r = renderScroll(false);
    await tick();
    expect(r.stdout.writes.some((w) => w.includes(ENABLE))).toBe(true);
    const beforeFlipCount = r.stdout.writes.filter((w) => w.includes(DISABLE)).length;
    r.rerender(true);
    await tick();
    const afterFlipCount = r.stdout.writes.filter((w) => w.includes(DISABLE)).length;
    expect(afterFlipCount).toBeGreaterThan(beforeFlipCount);
    r.unmount();
  });

  it('re-writes the enable sequence when `disabled` flips back to false', async () => {
    const r = renderScroll(false);
    await tick();
    r.rerender(true);
    await tick();
    const enableCountAfterDisable = r.stdout.writes.filter((w) => w.includes(ENABLE)).length;
    r.rerender(false);
    await tick();
    const enableCountAfterReenable = r.stdout.writes.filter((w) => w.includes(ENABLE)).length;
    expect(enableCountAfterReenable).toBeGreaterThan(enableCountAfterDisable);
    r.unmount();
  });

  it('writes the disable sequence at unmount when not disabled', async () => {
    const r = renderScroll(false);
    await tick();
    expect(r.stdout.writes.some((w) => w.includes(DISABLE))).toBe(false);
    r.unmount();
    await tick();
    expect(r.stdout.writes.some((w) => w.includes(DISABLE))).toBe(true);
  });
});

describe('ScrollRegion suppressArrows arbitration', () => {
  it('with suppressArrows falsy (default), ↓ / PgDn scroll the viewport — behaviour unchanged', async () => {
    const r = renderTallKeys(false);
    await tick(60);
    const before = topVisibleRow(r.currentFrame());
    expect(before).toBe(0); // starts pinned at the top

    r.stdin.write(DOWN);
    await tick(40);
    const afterArrow = topVisibleRow(r.currentFrame());
    expect(afterArrow).toBeGreaterThan(before);

    r.stdin.write(PAGE_DOWN);
    await tick(40);
    expect(topVisibleRow(r.currentFrame())).toBeGreaterThan(afterArrow);
    r.unmount();
  });

  it('with suppressArrows=true, ↑/↓/PgUp/PgDn leave the scroll offset untouched (keys fall through to the view)', async () => {
    const r = renderTallKeys(true);
    await tick(60);
    const before = topVisibleRow(r.currentFrame());
    expect(before).toBe(0);

    for (const seq of [DOWN, DOWN, PAGE_DOWN, UP, PAGE_UP]) {
      r.stdin.write(seq);
      await tick(30);
    }
    // The window never moved — every arrow / paging key was ignored by ScrollRegion and is left
    // for the view's own list-cursor handler.
    expect(topVisibleRow(r.currentFrame())).toBe(before);
    r.unmount();
  });

  it('with suppressArrows=true, the mouse-wheel SGR sequence STILL scrolls', async () => {
    const r = renderTallTty(true);
    await tick(60);
    const before = topVisibleRow(r.currentFrame());
    expect(before).toBe(0);

    // Wheel-down is handled by the stdin SGR `data` listener, outside useInput — the suppression
    // flag only gates keyboard keys, never the wheel.
    r.stdin.emit('data', Buffer.from(WHEEL_DOWN));
    await tick(40);
    expect(topVisibleRow(r.currentFrame())).toBeGreaterThan(before);
    r.unmount();
  });
});
