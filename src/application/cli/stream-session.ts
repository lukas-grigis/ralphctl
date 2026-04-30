/**
 * `streamSession` — launch a chain via {@link SessionManagerPort}, attach
 * to the runner, render events to stdout, and resolve with an exit code.
 *
 * Used by the workflow commands (refine / plan / ideate / start / feedback /
 * sessions attach). The runner is registered with the session manager so
 * the same chain can be inspected via `sessions list` mid-flight, but the
 * command's lifecycle is tied to the chain — when the chain settles, the
 * command exits.
 *
 * Ctrl+C is wired to abort the runner via `sessionManager.kill(id)`. The
 * chain settles to `aborted`, the listener emits the terminal event, and
 * the function resolves with `EXIT_INTERRUPTED`.
 */
import * as c from 'colorette';

import type { Element } from '../../kernel/chain/element.ts';
import type { ChainRunnerEvent } from '../../kernel/runtime/chain-runner.ts';
import type { SessionManagerPort } from '../runtime/session-manager-port.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_SUCCESS, type ExitCode } from './exit-codes.ts';

export interface StreamSessionOptions<TCtx> {
  readonly sessionManager: SessionManagerPort;
  readonly label: string;
  readonly element: Element<TCtx>;
  readonly initialCtx: TCtx;
  /**
   * Optional event renderer. Defaults to a plain-text renderer that prints
   * step transitions, error messages, and a final status line.
   */
  readonly render?: (event: ChainRunnerEvent<TCtx>) => string | undefined;
}

export async function streamSession<TCtx>(opts: StreamSessionOptions<TCtx>): Promise<ExitCode> {
  const { sessionManager, label, element, initialCtx, render = defaultRender } = opts;
  const id = sessionManager.start({ label, element, initialCtx });
  const descriptor = sessionManager.get(id);
  if (!descriptor) {
    process.stderr.write(c.red('error') + ' session vanished after start\n');
    return EXIT_ERROR;
  }
  process.stdout.write(c.dim(`session ${id} — ${label}`) + '\n');

  // Ctrl+C: kill the session. The runner emits 'aborted' which terminates
  // the await below, and we exit with EXIT_INTERRUPTED.
  let interrupted = false;
  const sigint = (): void => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(c.yellow('\n^C — aborting session…') + '\n');
    sessionManager.kill(id);
  };
  process.once('SIGINT', sigint);

  try {
    return await new Promise<ExitCode>((resolve) => {
      const unsubscribe = descriptor.runner.subscribe((event) => {
        const rendered = render(event as ChainRunnerEvent<TCtx>);
        if (rendered !== undefined && rendered.length > 0) {
          process.stdout.write(rendered + '\n');
        }
        if (event.type === 'completed') {
          unsubscribe();
          resolve(EXIT_SUCCESS);
        } else if (event.type === 'failed') {
          unsubscribe();
          resolve(EXIT_ERROR);
        } else if (event.type === 'aborted') {
          unsubscribe();
          resolve(interrupted ? EXIT_INTERRUPTED : EXIT_ERROR);
        }
      });
    });
  } finally {
    process.removeListener('SIGINT', sigint);
  }
}

function defaultRender<TCtx>(event: ChainRunnerEvent<TCtx>): string | undefined {
  switch (event.type) {
    case 'started':
      return c.dim('  → started');
    case 'step': {
      const { stepName, status, durationMs } = event.entry;
      const ms = durationMs > 0 ? c.dim(` (${String(Math.round(durationMs))}ms)`) : '';
      switch (status) {
        case 'completed':
          return `  ${c.green('✓')} ${stepName}${ms}`;
        case 'failed': {
          const err = event.entry.error;
          const msg = err ? `: ${err.message}` : '';
          return `  ${c.red('✗')} ${stepName}${msg}${ms}`;
        }
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
