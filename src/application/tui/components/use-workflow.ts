/**
 * useWorkflow — manages the phase lifecycle for CRUD / workflow views.
 *
 * A workflow view goes through three states:
 *   idle    — waiting; the view renders its initial content or a prompt
 *   running — async work in flight; spinner with a label
 *   done    — terminal state; ResultCard (success or error)
 *
 * Usage:
 *
 *   const { phase, run } = useWorkflow<Sprint>();
 *
 *   // Inside the component, kick off the async flow:
 *   run('Creating sprint…', async (setStep) => {
 *     setStep('Saving…');
 *     const result = await createSprint(deps, opts);
 *     if (!result.ok) throw new Error(result.error.message);
 *     return result.value;
 *   });
 *
 *   // Render:
 *   if (phase.kind === 'idle')    return <Spinner label="…" />  // or nothing
 *   if (phase.kind === 'running') return <Spinner label={phase.label} />
 *   if (phase.kind === 'done')    return phase.error
 *     ? <ResultCard kind="error" title={phase.error} />
 *     : <ResultCard kind="success" title="Done!" />
 */

import { useCallback, useState } from 'react';

export type WorkflowPhase<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly label: string }
  | { readonly kind: 'done'; readonly value: T; readonly error: null; readonly hint?: undefined }
  | { readonly kind: 'done'; readonly value: null; readonly error: string; readonly hint?: string };

export interface WorkflowHook<T> {
  readonly phase: WorkflowPhase<T>;
  /** Start the async flow. Catches throws and sets phase.error. */
  readonly run: (initialLabel: string, work: (setStep: (label: string) => void) => Promise<T>) => void;
  /** Manually reset to idle — e.g. to allow retrying. */
  readonly reset: () => void;
}

export function useWorkflow<T = void>(): WorkflowHook<T> {
  const [phase, setPhase] = useState<WorkflowPhase<T>>({ kind: 'idle' });

  const run = useCallback((initialLabel: string, work: (setStep: (label: string) => void) => Promise<T>): void => {
    setPhase({ kind: 'running', label: initialLabel });

    const setStep = (label: string): void => {
      setPhase({ kind: 'running', label });
    };

    void work(setStep).then(
      (value) => {
        setPhase({ kind: 'done', value, error: null });
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Surface a `hint` carried by domain errors (and any Error subclass that
        // assigns a string `hint` field) so views can pass it to ResultCard.
        const hint =
          typeof err === 'object' &&
          err !== null &&
          'hint' in err &&
          typeof (err as { hint?: unknown }).hint === 'string'
            ? (err as { hint: string }).hint
            : undefined;
        setPhase({
          kind: 'done',
          value: null,
          error: message,
          ...(hint !== undefined && hint.length > 0 ? { hint } : {}),
        });
      }
    );
  }, []);

  const reset = useCallback(() => {
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, run, reset };
}
