/**
 * Reusable "edit a string field on an entity" hook. Every browse / detail view that lists
 * entities (projects, sprints, tickets, repositories, tasks) wires `e` to one of these so the
 * operator can fix a typo without deleting + recreating the entity.
 *
 * Behaviour:
 *  - Opens an Ink prompt (single-line for `'short'`, multi-line for `'long'`) prefilled with the
 *    current value.
 *  - On submit, runs the optional `validate` step. Failure surfaces through `feedback`.
 *  - On success, calls `onSave` and surfaces its `Result` through `feedback`.
 *  - Esc on the prompt is a silent cancel — feedback is cleared, the entity is untouched.
 *
 * The hook owns no entity state. The caller's view holds the entity, decides which field is
 * focused, and triggers `openEditPrompt({ ... })` from a key handler. The hook is intentionally
 * thin — its job is only to keep the prompt-queue plumbing and the success / error rendering
 * consistent across every consumer.
 */

import { useCallback, useState } from 'react';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { PendingPromptInput, PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';

export type EditFieldKind = 'short' | 'long';

export interface OpenEditPromptInput {
  /** Title shown above the input — e.g. "Edit sprint name" or "Edit ticket description". */
  readonly title: string;
  /** Single-line vs multi-line. Short → TextPrompt, long → TextAreaPrompt. */
  readonly kind: EditFieldKind;
  /** Initial buffer; `undefined` opens with an empty buffer (used for optional fields). */
  readonly currentValue: string | undefined;
  /**
   * Optional pre-persistence validator. Receives the buffer (already trimmed for short fields by
   * the prompt adapter — see {@link InkInteractivePrompt}). Returning {@link Result.error}
   * surfaces the message inline; {@link Result.ok} feeds its value into {@link onSave}.
   *
   * The transform shape (`(string) => Result<string, ...>`) lets validators normalise the value
   * (e.g. lower-casing for slugs) without splitting the API surface.
   */
  readonly validate?: (raw: string) => Result<string, DomainError>;
  /** Persist the validated value. The hook surfaces the resulting message via {@link feedback}. */
  readonly onSave: (value: string) => Promise<Result<unknown, DomainError>>;
  /** Optional success label override. Defaults to `'✓ saved'`. */
  readonly successLabel?: string;
}

export interface UseEditFieldState {
  /** Feedback string for the caller to render under the entity card. Cleared by `reset`. */
  readonly feedback: string | undefined;
  /** Queue and run an edit prompt. Returns when the underlying queue resolves. */
  readonly openEditPrompt: (input: OpenEditPromptInput) => Promise<void>;
  /** Clear `feedback` — useful before launching a different operation that produces its own. */
  readonly reset: () => void;
}

const enqueueText = (queue: PromptQueue, title: string, kind: EditFieldKind, initial: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const base = { message: title, initial, resolve, reject };
    const prompt: PendingPromptInput = kind === 'short' ? { kind: 'text', ...base } : { kind: 'textarea', ...base };
    queue.enqueue(prompt);
  });

export const useEditField = (): UseEditFieldState => {
  const queue = usePromptQueue();
  const ui = useUiState();
  // Pin the stable callback so the useCallback dep list can reference it without re-firing on
  // every unrelated UI-state change (helpOpen, claims counter, …).
  const claimPrompt = ui.claimPrompt;
  const [feedback, setFeedbackState] = useState<string | undefined>(undefined);

  // Mounted-ref guard: `openEditPrompt` is async and the host view can unmount between the
  // initial keystroke and the prompt's resolution. Calling setState on an unmounted component
  // is a no-op in React 18+ but emits a dev warning and indicates a closure that survived
  // teardown. Every state mutation routes through `setFeedback` which checks it. `release()` in
  // the finally block is unconditional — the claim counter must always decrement even if the
  // view is gone.
  const mountedRef = useIsMounted();
  const setFeedback = useCallback(
    (value: string | undefined): void => {
      if (mountedRef.current) setFeedbackState(value);
    },
    [mountedRef]
  );

  const openEditPrompt = useCallback(
    async (input: OpenEditPromptInput): Promise<void> => {
      // Claim the global-key mute so background hotkeys (h/home, n/flows, …) don't fire while
      // the operator is typing. The prompt-host already does this for queued prompts but the
      // release is tied to the host's render cycle; we mirror the claim here for symmetry with
      // confirm-prompt consumers and so feedback runs the same code path on cancel.
      const release = claimPrompt();
      try {
        const raw = await enqueueText(queue, input.title, input.kind, input.currentValue ?? '');
        const normalised = input.validate ? input.validate(raw) : Result.ok(raw);
        if (!normalised.ok) {
          setFeedback(`✗ ${normalised.error.message}`);
          return;
        }
        const saved = await input.onSave(normalised.value);
        if (!saved.ok) {
          setFeedback(`✗ ${saved.error.message}`);
          return;
        }
        setFeedback(input.successLabel ?? '✓ saved');
      } catch (cause) {
        // AbortError is operator cancellation propagating up through the chain runtime — it must
        // pass through transparently (the run-abort path depends on it surfacing). This blanket
        // catch is the only seam between the prompt queue and the void'd callers in
        // `field-editors.ts`, so swallowing it here would strand the abort. `release()` in the
        // `finally` still runs before the re-throw.
        if (cause instanceof AbortError) throw cause;
        // Any other rejection means the user cancelled THIS prompt (esc — the queue rejects with a
        // plain `Error('cancelled by user')`, never an AbortError). No feedback: cancellation is
        // its own UI signal (the prompt disappears) and a "cancelled" chip on every esc is noisy.
        // Pre-existing feedback (from a previous edit) is cleared so the view doesn't carry stale
        // state.
        setFeedback(undefined);
      } finally {
        release();
      }
    },
    [queue, claimPrompt, setFeedback]
  );

  const reset = useCallback((): void => {
    setFeedback(undefined);
  }, [setFeedback]);

  return { feedback, openEditPrompt, reset };
};
