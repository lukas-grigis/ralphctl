/**
 * Verify daemon-spawn:
 *   - Sets `detached: true` and `stdio: ['ignore', logFd, logFd]`
 *   - Calls `child.unref()` so the parent's event loop can exit
 *   - Forwards `process.execArgv` so loader hooks (tsx) survive the re-exec
 *   - Returns the daemon PID
 *   - Errors out cleanly when no PID is assigned
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { spawnDaemon } from './daemon-spawn.ts';

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  options: { detached: boolean; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv };
}

function makeSpawn(
  pid: number | undefined,
  captured: CapturedSpawn[]
): {
  spawnFn: (command: string, args: readonly string[], options: CapturedSpawn['options']) => ChildProcess;
  unrefCount: { value: number };
} {
  const unrefCount = { value: 0 };
  const spawnFn = (command: string, args: readonly string[], options: CapturedSpawn['options']): ChildProcess => {
    captured.push({ command, args, options });
    return {
      pid,
      unref: () => {
        unrefCount.value += 1;
      },
    } as unknown as ChildProcess;
  };
  return { spawnFn, unrefCount };
}

describe('spawnDaemon', () => {
  it('spawns detached with stdio redirected to the log fd, then unrefs', () => {
    const captured: CapturedSpawn[] = [];
    const { spawnFn, unrefCount } = makeSpawn(54321, captured);
    const openLogFd = vi.fn(() => 7);

    const result = spawnDaemon({
      args: ['sprint', '__daemon-run', 'sprint-id'],
      logPath: '/tmp/daemon.log',
      cliScript: '/path/to/cli.mjs',
      nodeBin: '/usr/bin/node',
      inheritExecArgv: false,
      env: { FOO: 'bar' },
      spawnFn,
      openLogFd,
    });

    expect(result.pid).toBe(54321);
    expect(captured).toHaveLength(1);
    const spawn = captured[0];
    expect(spawn).toBeDefined();
    expect(spawn?.command).toBe('/usr/bin/node');
    expect(spawn?.args).toEqual(['/path/to/cli.mjs', 'sprint', '__daemon-run', 'sprint-id']);
    expect(spawn?.options.detached).toBe(true);
    expect(spawn?.options.stdio).toEqual(['ignore', 7, 7]);
    expect(spawn?.options.env).toEqual({ FOO: 'bar' });
    expect(openLogFd).toHaveBeenCalledWith('/tmp/daemon.log');
    expect(unrefCount.value).toBe(1);
  });

  it('forwards process.execArgv when inheritExecArgv defaults to true', () => {
    const captured: CapturedSpawn[] = [];
    const { spawnFn } = makeSpawn(99, captured);
    const originalArgv = process.execArgv;
    Object.defineProperty(process, 'execArgv', { value: ['--enable-source-maps'], configurable: true });
    try {
      spawnDaemon({
        args: ['x'],
        logPath: '/tmp/d.log',
        cliScript: '/cli.mjs',
        nodeBin: '/node',
        spawnFn,
        openLogFd: () => 4,
      });
    } finally {
      Object.defineProperty(process, 'execArgv', { value: originalArgv, configurable: true });
    }
    expect(captured[0]?.args).toEqual(['--enable-source-maps', '/cli.mjs', 'x']);
  });

  it('throws when the spawned child does not return a pid', () => {
    const captured: CapturedSpawn[] = [];
    const { spawnFn } = makeSpawn(undefined, captured);
    expect(() =>
      spawnDaemon({
        args: ['x'],
        logPath: '/tmp/d.log',
        cliScript: '/cli.mjs',
        nodeBin: '/node',
        inheritExecArgv: false,
        spawnFn,
        openLogFd: () => 5,
      })
    ).toThrow(/no pid/i);
  });
});
