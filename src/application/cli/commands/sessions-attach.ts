/**
 * `sessions attach <id>` — subscribe to a runner's events and stream them
 * to stdout. Ctrl+C detaches without killing the session.
 *
 * If the session has already settled, the runner replays its terminal
 * event synchronously on subscribe and the command exits.
 */
import type { Command } from 'commander';
import * as c from 'colorette';

import type { ChainRunnerEvent } from '@src/kernel/runtime/chain-runner.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';

export function attachSessionsAttach(group: Command, deps: SharedDeps): void {
  group
    .command('attach <id>')
    .description('attach to a session and stream its events to stdout')
    .action(async (id: string) => {
      const code = await runSessionsAttach(deps, id);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

async function runSessionsAttach(deps: SharedDeps, id: string): Promise<ExitCode> {
  const descriptor = deps.sessionManager.get(id);
  if (!descriptor) {
    process.stderr.write(c.red('error') + ` no session with id '${id}'\n`);
    return EXIT_ERROR;
  }

  let detached = false;
  const sigint = (): void => {
    if (detached) return;
    detached = true;
    process.stderr.write(c.yellow('\n^C — detaching (session keeps running)') + '\n');
  };
  process.once('SIGINT', sigint);

  try {
    return await new Promise<ExitCode>((resolve) => {
      const unsubscribe = descriptor.runner.subscribe((event) => {
        if (detached) {
          unsubscribe();
          resolve(EXIT_SUCCESS);
          return;
        }
        const rendered = renderEvent(event);
        if (rendered !== undefined) {
          process.stdout.write(rendered + '\n');
        }
        if (event.type === 'completed') {
          unsubscribe();
          resolve(EXIT_SUCCESS);
        } else if (event.type === 'failed' || event.type === 'aborted') {
          unsubscribe();
          resolve(event.type === 'failed' ? EXIT_ERROR : EXIT_SUCCESS);
        }
      });
    });
  } finally {
    process.removeListener('SIGINT', sigint);
  }
}

function renderEvent(event: ChainRunnerEvent<unknown>): string | undefined {
  switch (event.type) {
    case 'started':
      return c.dim('  → started');
    case 'step': {
      const { stepName, status, durationMs, error } = event.entry;
      const ms = durationMs > 0 ? c.dim(` (${String(Math.round(durationMs))}ms)`) : '';
      switch (status) {
        case 'completed':
          return `  ${c.green('✓')} ${stepName}${ms}`;
        case 'failed':
          return `  ${c.red('✗')} ${stepName}${error ? `: ${error.message}` : ''}${ms}`;
        case 'skipped':
          return `  ${c.dim('•')} ${stepName} ${c.dim('(skipped)')}`;
        case 'aborted':
          return `  ${c.yellow('!')} ${stepName} ${c.yellow('(aborted)')}`;
      }
      return undefined;
    }
    case 'completed':
      return c.green('done');
    case 'failed':
      return c.red(`failed: ${event.error.message}`);
    case 'aborted':
      return c.yellow('aborted');
  }
}
