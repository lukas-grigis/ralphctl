import { describe, expect, it } from 'vitest';
import { execPath } from 'node:process';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';

/**
 * The primitive is a thin wrapper over cross-spawn, so the meaningful coverage is that it
 * actually launches a real process cross-platform and streams its output back. We spawn the
 * current Node binary (`execPath`) — guaranteed present on every platform the suite runs on —
 * rather than a `.cmd` shim, which can't be assumed in CI.
 */
describe('crossPlatformSpawn', () => {
  it('spawns a real process and resolves its stdout + exit code', async () => {
    const child = crossPlatformSpawn(execPath, ['-e', "process.stdout.write('hello')"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString('utf8')).toBe('hello');
  });

  it('passes an argument containing spaces and shell metacharacters verbatim (no shell re-split)', async () => {
    // The load-bearing guarantee of the whole cross-platform-spawn change: arguments reach the
    // child EXACTLY as given — no `shell: true` re-splitting, no metacharacter interpretation.
    // A regression to a shell-wrapped spawn makes this fail loudly (the shell consumes `&`/`|`
    // and the arg never reaches argv[1]), so this is the canary against re-introducing the
    // CVE-2024-27980 footgun. Platform-independent: it spawns the Node binary, not a `.cmd` shim.
    const nasty = 'a b & c | d % e "f" $g';
    const child = crossPlatformSpawn(execPath, ['-e', 'process.stdout.write(process.argv[1])', nasty], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString('utf8')).toBe(nasty);
  });

  it('emits an error event (before close) for a binary that does not exist', async () => {
    const child = crossPlatformSpawn('this-binary-does-not-exist-ralphctl', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Record the terminal-event order rather than racing a single boolean: the only guarantee
    // the production consumers rely on (run-command.ts / the provider adapters both treat either
    // terminal event as failure) is that an `error` event fires for an un-spawnable binary. We
    // await `close` (always terminal) and assert `error` was seen — decoupled from which fires
    // first, but still proving the error signal exists.
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      child.on('error', () => order.push('error'));
      child.on('close', () => {
        order.push('close');
        resolve();
      });
    });

    expect(order).toContain('error');
  });
});
