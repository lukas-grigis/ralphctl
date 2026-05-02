/**
 * `sessions list` — print every registered session in the current process.
 *
 * Note: in CLI mode, sessions live for the duration of one process. The
 * primary use of this command is during a TUI invocation; running it
 * standalone after a CLI command exited will show an empty list. In CLI
 * surface, it is mostly useful for debugging when a workflow command is
 * still executing in another shell.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type { SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

export function attachSessionsList(group: Command, deps: SharedDeps): void {
  group
    .command('list')
    .description('list active sessions')
    .action(async () => {
      const code = await runSessionsList(deps);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export function runSessionsList(deps: SharedDeps): Promise<ExitCode> {
  const list = deps.sessionManager.list();
  if (list.length === 0) {
    process.stdout.write(c.dim('No active sessions.') + '\n');
    return Promise.resolve(EXIT_SUCCESS);
  }
  const lines: string[] = [c.bold('Sessions')];
  const active = deps.sessionManager.active;
  for (const s of list) {
    lines.push(formatSessionLine(s, active?.id === s.id));
  }
  process.stdout.write(lines.join('\n') + '\n');
  return Promise.resolve(EXIT_SUCCESS);
}

function formatSessionLine(s: SessionDescriptor, isActive: boolean): string {
  const marker = isActive ? c.green('*') : ' ';
  const id = c.dim(s.id);
  const status = colorStatus(s.status);
  const label = c.bold(s.label);
  return `  ${marker} ${id}  ${status.padEnd(20)}  ${label}  ${c.dim(s.startedAt)}`;
}

function colorStatus(status: SessionDescriptor['status']): string {
  switch (status) {
    case 'idle':
      return c.dim('idle');
    case 'running':
      return c.yellow('running');
    case 'completed':
      return c.green('completed');
    case 'failed':
      return c.red('failed');
    case 'aborted':
      return c.yellow('aborted');
  }
}
