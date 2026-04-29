/**
 * Integration: a real detached child process survives SIGHUP to the parent.
 *
 * Boots an outer "parent" Node process via `child_process.spawn`. The parent
 * uses the same `detached: true` + `child.unref()` pattern that `spawnDaemon`
 * uses to fork a long-running "daemon" Node process whose only job is to
 * write its PID to a sentinel file, then sleep. We then SIGHUP the parent,
 * wait for it to exit, and assert the daemon's PID is still reachable via
 * `process.kill(pid, 0)`.
 *
 * The test is platform-conditional: SIGHUP semantics here exercise POSIX
 * behaviour. On Windows the test no-ops.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'ralphctl-daemon-int-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    return code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

const skipOnWindows = process.platform === 'win32' ? it.skip : it;

describe('daemon survives parent SIGHUP', () => {
  skipOnWindows(
    'parent forks detached child, SIGHUPs parent, child stays alive',
    async () => {
      const daemonScript = join(workdir, 'daemon.mjs');
      const parentScript = join(workdir, 'parent.mjs');
      const pidFile = join(workdir, 'daemon.pid');
      const logFile = join(workdir, 'daemon.log');

      await writeFile(
        daemonScript,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
// Stay alive for 30 s — enough time for the parent to die and us to assert.
setTimeout(() => process.exit(0), 30000);
`
      );

      // Replicate exactly the pattern spawnDaemon uses (detached + unref +
      // stdio routed to log fd) so the integration test exercises the same
      // OS surface the production code does.
      await writeFile(
        parentScript,
        `import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
const logFd = openSync(${JSON.stringify(logFile)}, 'a');
const child = spawn(process.execPath, [${JSON.stringify(daemonScript)}], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
process.stdout.write('daemon-pid:' + String(child.pid) + '\\n');
// Hold the parent alive briefly so the test has a stable target to SIGHUP.
setTimeout(() => process.exit(0), 8000);
`
      );

      const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      parent.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf-8');
      });

      try {
        // Wait for the parent to print the daemon's PID.
        const gotPid = await waitFor(() => /daemon-pid:\d+/.test(stdoutBuf), 5000);
        expect(gotPid).toBe(true);
        const match = /daemon-pid:(\d+)/.exec(stdoutBuf);
        expect(match).not.toBeNull();
        const daemonPid = parseInt(match?.[1] ?? '0', 10);
        expect(daemonPid).toBeGreaterThan(0);

        // Daemon must have written its PID file as proof of life.
        const pidFileWritten = await waitFor(() => existsSync(pidFile), 5000);
        expect(pidFileWritten).toBe(true);
        const persistedPid = parseInt((await readFile(pidFile, 'utf-8')).trim(), 10);
        expect(persistedPid).toBe(daemonPid);

        expect(isAlive(daemonPid)).toBe(true);

        // SIGHUP the parent and wait for it to die.
        parent.kill('SIGHUP');
        const parentDead = await waitFor(() => parent.exitCode !== null || parent.signalCode !== null, 5000);
        expect(parentDead).toBe(true);

        // The daemon must outlive the parent.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(isAlive(daemonPid)).toBe(true);

        // Cleanup — terminate the daemon ourselves so the test process
        // isn't left babysitting a zombie.
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {
          // already gone
        }
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill('SIGKILL');
        }
      }
    },
    20_000
  );
});
