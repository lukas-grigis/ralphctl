/**
 * `useWorkflow` — shared state-machine hook for native Ink workflow views.
 *
 * Every workflow view follows the same shape: mount → run an async flow
 * (prompts, persistence, external calls) → settle into a terminal state
 * (`done`, `error`, or a domain-specific dead end like `cancelled`,
 * `no-candidates`). On terminal, Enter pops back to the previous view;
 * Esc is handled globally by the router.
 *
 * Usage:
 *
 *   type Phase = { kind: 'running'; step: 'input' } | { kind: 'done'; … } | { kind: 'error'; … };
 *   const { phase, setPhase } = useWorkflow<Phase>({ kind: 'running', step: 'input' }, async () => {
 *     const name = await getPrompt().input({ ... });
 *     await createSprint(name);
 *     setPhase({ kind: 'done', name });
 *   });
 *
 * Keeps the view's render function focused on presentation; the boilerplate
 * of `started` guard, PromptCancelledError handling, and Enter-to-return
 * lives here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useInput } from 'ink';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

/**
 * Caller describes their phase union. `useWorkflow` doesn't care about the
 * shape beyond "there is a `kind` discriminator" — that's a hint to the
 * view, not enforced at the type level, so each view can pick the phase
 * shape that best fits its flow.
 */
export interface WorkflowPhase {
  readonly kind: string;
}

export interface UseWorkflowResult<TPhase extends WorkflowPhase> {
  readonly phase: TPhase;
  readonly setPhase: (next: TPhase) => void;
}

export interface UseWorkflowOptions<TPhase extends WorkflowPhase> {
  /** Initial phase (typically a `running` kind). */
  readonly initial: TPhase;
  /** The async flow that drives the view through prompts / persistence. */
  readonly run: (api: { setPhase: (next: TPhase) => void }) => Promise<void>;
  /**
   * Discriminator predicate: does `phase.kind` represent a terminal state
   * (Enter on it returns home)? Default: anything other than `running` /
   * `loading` is terminal.
   */
  readonly isTerminal?: (phase: TPhase) => boolean;
  /**
   * Discriminator predicate: can the user interact (via `useInput`) in this
   * phase? Default: anything *not* `running` or `loading` is interactive.
   */
  readonly isInteractive?: (phase: TPhase) => boolean;
  /** Convert errors into an error phase. */
  readonly onError: (message: string) => TPhase;
}

const DEFAULT_NON_INTERACTIVE = new Set(['running', 'loading']);

function defaultIsTerminal(phase: WorkflowPhase): boolean {
  return !DEFAULT_NON_INTERACTIVE.has(phase.kind);
}

function defaultIsInteractive(phase: WorkflowPhase): boolean {
  return !DEFAULT_NON_INTERACTIVE.has(phase.kind);
}

export function useWorkflow<TPhase extends WorkflowPhase>(
  options: UseWorkflowOptions<TPhase>
): UseWorkflowResult<TPhase> {
  const router = useRouter();
  const [phase, setPhase] = useState(options.initial);
  const [started, setStarted] = useState(false);

  const isTerminal = options.isTerminal ?? defaultIsTerminal;
  const isInteractive = options.isInteractive ?? defaultIsInteractive;

  const kick = useCallback(async (): Promise<void> => {
    try {
      await options.run({ setPhase });
    } catch (err) {
      if (err instanceof PromptCancelledError) {
        router.pop();
        return;
      }
      setPhase(options.onError(err instanceof Error ? err.message : String(err)));
    }
  }, [options, router]);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void kick();
  }, [started, kick]);

  // Enter on a terminal state returns home. Esc is handled globally by the
  // ViewRouter; not re-dispatching here avoids double-pop.
  useInput(
    (_input, key) => {
      if (key.return && isTerminal(phase)) router.pop();
    },
    { isActive: isInteractive(phase) }
  );

  return { phase, setPhase };
}
