/**
 * `sessions detach <id>` — drop the active marker from the session if it
 * is currently active.
 *
 * In the CLI surface this is mostly a no-op since detach happens
 * automatically when a workflow command exits. Kept for parity with the
 * TUI surface so scripted callers can call the same command set.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

export function attachSessionsDetach(group: Command, deps: SharedDeps): void {
  group
    .command('detach <id>')
    .description('drop the active marker from a session (CLI: mostly a no-op)')
    .action(async (id: string) => {
      const code = await runSessionsDetach(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export function runSessionsDetach(deps: SharedDeps, id: string): Promise<ExitCode> {
  const result = deps.sessionManager.background(id);
  if (!result.ok) {
    process.stderr.write(c.red('error') + ` ${result.error.message}\n`);
    return Promise.resolve(EXIT_ERROR);
  }
  process.stdout.write(c.green('detached') + ` ${c.dim(id)}\n`);
  return Promise.resolve(EXIT_SUCCESS);
}
