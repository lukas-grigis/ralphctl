import { spawn } from 'node:child_process';

/**
 * Check whether a named executable resolves on the current `PATH`. Cross-platform — the single
 * detection mechanism both the doctor probes and the launch-time fail-fast route through, so the
 * two surfaces can never disagree about whether a CLI is installed.
 *
 *   - Windows: spawn `where <name>`. `where.exe` is a real System32 binary (so no shell is
 *     needed) and it resolves every executable kind on `PATHEXT` — `.exe`, `.cmd`, `.ps1`,
 *     `.bat` — which is what npm / winget shims install (`claude.cmd`, `gh.cmd`, …). A bare
 *     `spawn(name)` cannot launch a `.cmd` shim, and the POSIX `command -v` builtin does not
 *     exist in `cmd.exe`, so neither is safe here.
 *   - POSIX: spawn `command -v <name>` under a shell. `command` is a POSIX shell builtin
 *     (hence `shell: true`) mandated to report PATH presence without executing the target.
 *
 * Resolution policy (identical on both platforms):
 *
 *   - exit code 0       → on PATH (resolves `true`)
 *   - exit code non-zero → not on PATH (resolves `false`)
 *   - `error` event      → treat as missing (resolves `false`)
 *
 * No version check, no auth probe, no execution of the target binary — just presence.
 */
export const commandExists = (name: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('where', [name], { stdio: 'ignore' })
        : spawn('command', ['-v', name], { stdio: 'ignore', shell: true });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', () => settle(false));
    child.on('exit', (code) => settle(code === 0));
  });
