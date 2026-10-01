/** Reusable "edit a string field on an entity" hook. */

import { useCallback, useState } from 'react';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { PendingPromptInput, PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

export type EditFieldKind = 'short' | 'long';

export interface OpenEditPromptInput {
  /** Title shown above the input — e.g. "Edit sprint name" or "Edit ticket description". */
  readonly title: string;
  /** Single-line vs multi-line. Short → TextPrompt, long → TextAreaPrompt. */
  readonly kind: EditFieldKind;
  /** Initial buffer; `undefined` opens with an empty buffer (used for optional fields). */
  readonly currentValue: string | undefined;
  /**
   * Optional pre-persistence validator. Receives the buffer (already trimmed for short fields by the prompt adapter —
   * see {@link InkInteractivePrompt}).
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

  // Mounted-ref guard: `openEditPrompt` is async and the host view can unmount between the initial keystroke and the
  // prompt's resolution.
  const mountedRef = useIsMounted();
  const setFeedback = useCallback(
    (value: string | undefined): void => {
      if (mountedRef.current) setFeedbackState(value);
    },
    [mountedRef]
  );

  const openEditPrompt = useCallback(
    async (input: OpenEditPromptInput): Promise<void> => {
      // Claim the global-key mute so background hotkeys (h/home, n/flows, …) don't fire while the operator is typing.
      const release = claimPrompt();
      try {
        const raw = await enqueueText(queue, input.title, input.kind, input.currentValue ?? '');
        const normalised = input.validate ? input.validate(raw) : Result.ok(raw);
        if (!normalised.ok) {
          setFeedback(`${glyphs.cross} ${normalised.error.message}`);
          return;
        }
        const saved = await input.onSave(normalised.value);
        if (!saved.ok) {
          setFeedback(`${glyphs.cross} ${saved.error.message}`);
          return;
        }
        setFeedback(input.successLabel ?? `${glyphs.check} saved`);
      } catch (cause) {
        // AbortError is operator cancellation propagating up through the chain runtime — it must pass through
        // transparently (the run-abort path depends on it surfacing).
        if (cause instanceof AbortError) throw cause;
        // Any other rejection means the user cancelled THIS prompt (esc — the queue rejects with a plain
        // `Error('cancelled by user')`, never an AbortError).
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
