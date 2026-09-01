/**
 * Ink 7's `suspendTerminal` is the supported way to hand a TTY to a child process. The previous
 * host path fully unmounted the tree (and remounted after), which left Grok's pager unable to
 * attach — refine-with-grok spawned, logged early startup, then died before `pager started`.
 *
 * This pins: while TerminalHandoff is mounted, `getRunInTerminal` runs the callback without
 * tearing the Ink tree down.
 */

import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalHandoff } from '@src/application/ui/tui/runtime/terminal-handoff.tsx';
import { getRunInTerminal, setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';

const flush = async (): Promise<void> => {
  await new Promise((res) => setTimeout(res, 5));
};

afterEach(() => {
  setRunInTerminal(passthroughRunInTerminal);
});

describe('TerminalHandoff', () => {
  it('runs getRunInTerminal without unmounting the Ink tree', async () => {
    const r = render(
      <>
        <TerminalHandoff />
        <Text>handoff-alive</Text>
      </>
    );
    await flush();

    expect(r.lastFrame()).toContain('handoff-alive');

    let ran = false;
    await getRunInTerminal()(async () => {
      ran = true;
      // Tree must still be mounted mid-handoff — unmount/remount would blank the frame.
      expect(r.lastFrame()).toContain('handoff-alive');
      return 'ok';
    });

    expect(ran).toBe(true);
    expect(r.lastFrame()).toContain('handoff-alive');
    r.unmount();
  });

  it('restores the previous runInTerminal on unmount', async () => {
    let via = '';
    const previous = async <T,>(fn: () => Promise<T>): Promise<T> => {
      via = 'previous';
      return fn();
    };
    setRunInTerminal(previous);

    const r = render(<TerminalHandoff />);
    await flush();
    r.unmount();
    await flush();

    await getRunInTerminal()(async () => 'x');
    expect(via).toBe('previous');
  });

  it('replaces a fallback installed before mount so every interactive CLI uses suspend, not unmount', async () => {
    let via = '';
    const fallback = async <T,>(fn: () => Promise<T>): Promise<T> => {
      via = 'fallback';
      return fn();
    };
    setRunInTerminal(fallback);

    const r = render(
      <>
        <TerminalHandoff />
        <Text>handoff-alive</Text>
      </>
    );
    await flush();

    const result = await getRunInTerminal()(async () => {
      via = 'suspend';
      return 'from-child';
    });
    expect(via).toBe('suspend');
    expect(result).toBe('from-child');
    expect(r.lastFrame()).toContain('handoff-alive');
    r.unmount();
  });

  it('propagates a child error and still leaves the Ink tree mounted for the next CLI', async () => {
    const r = render(
      <>
        <TerminalHandoff />
        <Text>handoff-alive</Text>
      </>
    );
    await flush();

    await expect(
      getRunInTerminal()(async () => {
        throw new Error('interactive-claude: session exited with code 1');
      })
    ).rejects.toThrow('interactive-claude: session exited with code 1');
    expect(r.lastFrame()).toContain('handoff-alive');

    const again = await getRunInTerminal()(async () => 'second-session');
    expect(again).toBe('second-session');
    expect(r.lastFrame()).toContain('handoff-alive');
    r.unmount();
  });

  it('runs sequential handoffs (refine ticket A then B, or plan after refine)', async () => {
    const r = render(
      <>
        <TerminalHandoff />
        <Text>handoff-alive</Text>
      </>
    );
    await flush();

    const first = await getRunInTerminal()(async () => 'ticket-a');
    const second = await getRunInTerminal()(async () => 'ticket-b');
    expect(first).toBe('ticket-a');
    expect(second).toBe('ticket-b');
    expect(r.lastFrame()).toContain('handoff-alive');
    r.unmount();
  });
});
