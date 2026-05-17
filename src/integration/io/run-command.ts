import { execFile } from 'node:child_process';

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
 */
export type RunCommand = (name: string, args: readonly string[]) => Promise<RunCommandResult>;

export const runCommand: RunCommand = (name, args) =>
  new Promise((resolve) => {
    execFile(name, [...args], { timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ ok: true, code: 0, stdout, stderr });
        return;
      }
      // err.code is `'ENOENT'` when the binary is missing, the numeric exit code otherwise.
      const code = typeof err.code === 'number' ? err.code : null;
      resolve({ ok: false, code, stdout, stderr });
    });
  });
