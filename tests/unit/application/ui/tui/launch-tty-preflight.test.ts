import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchTui } from '@src/application/ui/tui/launch.ts';

/**
 * TTY pre-flight: bare `ralphctl` on a non-TTY stdin/stdout must fail fast with a one-line stderr
 * hint and a non-zero exit code — never mount Ink (which would dump a raw-mode stack trace to
 * stdout and exit 0). The bail is the first statement in launchTui, so bootstrap never runs.
 */
describe('launchTui TTY pre-flight', () => {
  const originalStdinTty = process.stdin.isTTY;
  const originalStdoutTty = process.stdout.isTTY;
  const originalExitCode = process.exitCode;
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdin.isTTY = originalStdinTty;
    process.stdout.isTTY = originalStdoutTty;
    process.exitCode = originalExitCode;
  });

  it('fails gracefully when stdin is not a TTY', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;

    await launchTui();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('the interactive TUI requires a terminal');
    expect(stderr).toContain('ralphctl --help');
    // No Ink stack trace leaked to the operator.
    expect(stderr).not.toContain('Raw mode is not supported');
  });

  it('fails gracefully when stdout is not a TTY', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;

    await launchTui();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('the interactive TUI requires a terminal');
  });
});
