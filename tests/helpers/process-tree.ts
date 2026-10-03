/**
 * Real-process helpers for the process-lifecycle tests: a stub AI CLI that forks a long-lived
 * grandchild (the stand-in for a tool subprocess) and records both pids, plus liveness polling.
 * Never a real AI CLI.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface StubCli {
  /** Absolute path of the executable stub. */
  readonly command: string;
  readonly dir: string;
  /** Resolves once the stub has written both pids. */
  pids(timeoutMs?: number): Promise<{ readonly child: number; readonly grandchild: number }>;
}

/**
 * Write an executable `name` into `dir` that drains stdin, forks `sleep 300`, records
 * `<dir>/child.pid` + `<dir>/grandchild.pid`, and waits — answering `--version` like the retest stub.
 */
export const writeStubCli = async (dir: string, name = 'claude'): Promise<StubCli> => {
  await fs.mkdir(dir, { recursive: true });
  const command = join(dir, name);
  const script = [
    '#!/bin/sh',
    'for a in "$@"; do if [ "$a" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi; done',
    'cat > /dev/null',
    'sleep 300 &',
    `echo $! > "${join(dir, 'grandchild.pid')}"`,
    `echo $$ > "${join(dir, 'child.pid')}"`,
    // One stdout line after the pids land, so an idle watchdog counts from here, not from spawn.
    'echo \'{"type":"system","subtype":"stub-ready"}\'',
    'wait',
    '',
  ].join('\n');
  await fs.writeFile(command, script, { mode: 0o755 });
  return {
    command,
    dir,
    pids: async (timeoutMs = 10_000) => {
      const read = async (file: string): Promise<number | undefined> => {
        try {
          const n = Number((await fs.readFile(join(dir, file), 'utf8')).trim());
          return Number.isInteger(n) && n > 0 ? n : undefined;
        } catch {
          return undefined;
        }
      };
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const child = await read('child.pid');
        const grandchild = await read('grandchild.pid');
        if (child !== undefined && grandchild !== undefined) return { child, grandchild };
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`stub CLI in ${dir} never wrote its pids`);
    },
  };
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Poll until every pid is gone; resolves false if any survives `timeoutMs`. */
export const waitForDeath = async (pids: readonly number[], timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pids.every((pid) => !isAlive(pid));
};

/** Test cleanup: SIGKILL whatever is still alive. */
export const killQuietly = (pids: readonly number[]): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
};
