/**
 * Ink owns DEC mode 2004: it is enabled while a text prompt is mounted and disabled on unmount
 * (including Ink's signal-exit unmount), so the mode never outlives the TUI in the user's shell.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ENABLE = `${String.fromCharCode(27)}[?2004h`;
const DISABLE = `${String.fromCharCode(27)}[?2004l`;

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  readonly writes: string[] = [];
  write = (chunk: string): boolean => {
    this.writes.push(chunk);
    return true;
  };
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
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

describe('bracketed paste mode ownership', () => {
  it('enables mode 2004 while a text prompt is mounted and disables it on unmount', async () => {
    const stdout = new FakeStdout();
    const instance = render(<TextPrompt message="Name" onSubmit={() => undefined} onCancel={() => undefined} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await tick();
    expect(stdout.writes).toContain(ENABLE);
    expect(stdout.writes).not.toContain(DISABLE);

    instance.unmount();
    await tick();
    expect(stdout.writes).toContain(DISABLE);
  });
});
