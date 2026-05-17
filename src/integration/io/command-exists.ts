import { spawn } from 'node:child_process';

/**
 * Check whether a named executable resolves on the current `PATH`. Implementation: spawn
 * `<name> --version` with stdio fully suppressed; resolution depends on the spawn outcome:
 *
 *   - `error` event with `ENOENT`     → not on PATH (resolves `false`)
 *   - `error` event with anything else → resolves `false` (treat as missing)
 *   - process exits cleanly            → resolves `true`
 *   - process exits non-zero           → resolves `true` (the binary exists; `--version`
 *                                        may not be supported but the executable was found)
 *
 * This is intentionally lightweight — no `which` shelling, no PATH parsing, no Windows fork.
 * Doctor uses it to tell the user "you don't have <provider> CLI installed" before they try
 * to run a flow that depends on it.
 */
export const commandExists = (name: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(name, ['--version'], { stdio: 'ignore' });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', () => settle(false));
    child.on('exit', () => settle(true));
  });
