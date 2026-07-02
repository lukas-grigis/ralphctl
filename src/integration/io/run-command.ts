import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';

/**
 * Result of running an external command. `ok` is true iff the process spawned and exited 0.
 * `code` is the numeric exit code when the process ran (even non-zero); `null` means the
 * binary couldn't be spawned at all (ENOENT) — callers that already used
 * `commandExists` won't see that.
 */
export interface RunCommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One-shot command runner used by sanity probes (doctor) — captures stdout/stderr and exit
 * code without surfacing process-spawn errors as exceptions. Stripped of the cwd/env knobs
 * the longer-running runners need; probes only ever ask "did `gh auth status` exit clean?".
 *
 * Spawns through {@link crossPlatformSpawn} rather than `execFile` so Windows `.cmd` shims
 * resolve — `gh` / `codex` are installed as `gh.cmd` / `codex.cmd` by npm/winget, which a bare
 * `execFile` cannot launch. A 5s wall-clock timeout kills a wedged probe and resolves with
 * `ok: false`.
 */
export type RunCommand = (name: string, args: readonly string[]) => Promise<RunCommandResult>;

const PROBE_TIMEOUT_MS = 5000;

export const runCommand: RunCommand = (name, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = crossPlatformSpawn(name, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // Synchronous spawn failure (e.g. invalid command shape) — treat as missing binary.
      resolve({ ok: false, code: null, stdout: '', stderr: '' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const settle = (result: RunCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // SIGTERM → grace → SIGKILL: a wedged probe that ignores SIGTERM is still reaped rather
      // than left running after we settle. Resolution is not delayed.
      killWithEscalation(child);
      settle({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    // ENOENT / EINVAL etc. — the binary couldn't be spawned at all.
    child.on('error', () => settle({ ok: false, code: null, stdout: '', stderr: '' }));

    child.on('close', (code) => {
      settle({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
