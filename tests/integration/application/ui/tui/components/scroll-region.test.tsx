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

import { describe, expect, it } from 'vitest';
import { render as inkRender, Text } from 'ink';
import { EventEmitter } from 'node:events';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';

const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';

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
