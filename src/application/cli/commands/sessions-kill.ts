/**
 * `sessions kill <id>` — abort a session and remove it from the registry.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';

export function attachSessionsKill(group: Command, deps: SharedDeps): void {
  group
    .command('kill <id>')
    .description('abort and remove a session')
    .action(async (id: string) => {
      const code = await runSessionsKill(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export function runSessionsKill(deps: SharedDeps, id: string): Promise<ExitCode> {
  const result = deps.sessionManager.kill(id);
  if (!result.ok) {
    process.stderr.write(c.red('error') + ` ${result.error.message}\n`);
    return Promise.resolve(EXIT_ERROR);
  }
  process.stdout.write(c.green('killed') + ` ${c.dim(id)}\n`);
  return Promise.resolve(EXIT_SUCCESS);
}
