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

  it('emits an error event for a binary that does not exist', async () => {
    const child = crossPlatformSpawn('this-binary-does-not-exist-ralphctl', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const errored = await new Promise<boolean>((resolve) => {
      child.on('error', () => resolve(true));
      child.on('close', () => resolve(false));
    });

    expect(errored).toBe(true);
  });
});
