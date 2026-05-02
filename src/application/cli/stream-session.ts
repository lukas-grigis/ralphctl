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
 * Ctrl+C is wired to a graceful confirm-then-kill flow:
 *   - First Ctrl+C: prompt the user for confirmation. If they confirm, the
 *     runner is aborted via `sessionManager.kill(id)` and the function
 *     resolves with `EXIT_INTERRUPTED`. If they decline, streaming
 *     continues.
 *   - Second Ctrl+C while a confirm is in flight: hard-cancel — bypass the
 *     prompt and kill immediately. Useful when the prompt itself becomes
 *     unresponsive.
 *
 * Non-TTY / piped invocations skip the prompt and hard-kill on the first
 * SIGINT (consistent with traditional Unix CLI behaviour).
 */
import * as c from 'colorette';

import { PromptCancelledError, type PromptPort } from '@src/business/ports/prompt-port.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import type { ChainRunnerEvent } from '@src/kernel/runtime/chain-runner.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_SUCCESS, type ExitCode } from './exit-codes.ts';

export interface StreamSessionOptions<TCtx> {
  readonly sessionManager: SessionManagerPort;
  readonly label: string;
  readonly element: Element<TCtx>;
  readonly initialCtx: TCtx;
  /**
   * Optional prompt port for the SIGINT confirmation flow. When omitted (or
   * stdin/stdout is not a TTY) the first SIGINT hard-kills.
   */
  readonly prompt?: PromptPort;
  /**
   * Optional event renderer. Defaults to a plain-text renderer that prints
   * step transitions, error messages, and a final status line.
   */
  readonly render?: (event: ChainRunnerEvent<TCtx>) => string | undefined;
}

export async function streamSession<TCtx>(opts: StreamSessionOptions<TCtx>): Promise<ExitCode> {
  const { sessionManager, label, element, initialCtx, prompt, render = defaultRender } = opts;
  const id = sessionManager.start({ label, element, initialCtx });
  const descriptor = sessionManager.get(id);
  if (!descriptor) {
    process.stderr.write(c.red('error') + ' session vanished after start\n');
    return EXIT_ERROR;
  }
  process.stdout.write(c.dim(`session ${id} — ${label}`) + '\n');

  // Ctrl+C lifecycle:
  //  - state 'idle'    → first SIGINT, ask for confirm (interactive only).
  //  - state 'asking'  → confirm prompt is in flight. A second Ctrl+C
  //                       short-circuits the prompt and kills.
  //  - state 'killing' → kill already issued; further SIGINTs are no-ops.
  let cancelState: 'idle' | 'asking' | 'killing' = 'idle';
  let interrupted = false;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && prompt !== undefined;

  const hardKill = (): void => {
    if (cancelState === 'killing') return;
    cancelState = 'killing';
    interrupted = true;
    process.stderr.write(c.yellow('\n^C — aborting session…') + '\n');
    sessionManager.kill(id);
  };

  const askToCancel = async (): Promise<void> => {
    if (cancelState !== 'idle') return;
    if (!interactive) {
      hardKill();
      return;
    }
    cancelState = 'asking';
    // `interactive` already includes `prompt !== undefined`; narrow into a
    // local so TS sees a definite PromptPort below.
    const interactivePrompt: PromptPort = prompt;
    try {
      const ok = await interactivePrompt.confirm({
        message: 'Cancel running session and mark blocked?',
        default: false,
      });
      // Second Ctrl+C may have raced past us (transitioning to 'killing').
      // Re-check the state via a `string` widening so the discriminator
      // doesn't narrow away the killing branch.
      if ((cancelState as string) === 'killing') return;
      if (ok) {
        hardKill();
      } else {
        cancelState = 'idle';
        process.stdout.write(c.dim('continuing…') + '\n');
      }
    } catch (err) {
      // PromptCancelledError (Esc on the prompt) → resume streaming.
      // Any other error → fall through to hard-kill so the user has an
      // escape hatch even if the prompt layer is broken.
      if (err instanceof PromptCancelledError) {
        cancelState = 'idle';
        return;
      }
      hardKill();
    }
  };

  const sigint = (): void => {
    if (cancelState === 'asking') {
      hardKill();
      return;
    }
    if (cancelState === 'idle') {
      void askToCancel();
    }
  };
  process.on('SIGINT', sigint);

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
