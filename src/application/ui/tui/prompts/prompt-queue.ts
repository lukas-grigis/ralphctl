/**
 * Module-level prompt queue. The TUI bridges sync chain code (use cases call
 * `interactive.askConfirm(...)` and `await` the answer) into the React tree by:
 *  1. Enqueuing a `PendingPrompt` here, returning a Promise that the chain awaits.
 *  2. The `<PromptHost>` component reads the head of this queue and renders the matching
 *     prompt component. When the user resolves / cancels, we resolve / reject the promise.
 *  3. The next prompt — if any — slides into view; chains see a sequential, non-overlapping
 *     stream of questions even when the surrounding code naively kicks off many at once.
 *
 * Mutex semantics are critical. Only the head renders at any given time. Callers that want to
 * batch-collect answers must serialise them themselves; the queue serialises them by default.
 */

import type { Choice } from '@src/business/interactive/prompt.ts';

export type PromptKind = 'text' | 'textarea' | 'confirm' | 'choice' | 'multi-choice';

export interface BasePrompt {
  readonly id: number;
  readonly kind: PromptKind;
  readonly message: string;
}

export interface TextPrompt extends BasePrompt {
  readonly kind: 'text';
  /** Optional pre-filled buffer — surfaced to the renderer as the `initial` value. */
  readonly initial?: string;
  resolve(value: string): void;
  reject(err: Error): void;
}

export interface TextAreaPrompt extends BasePrompt {
  readonly kind: 'textarea';
  /** Optional pre-filled buffer; preserved verbatim incl. newlines. */
  readonly initial?: string;
  resolve(value: string): void;
  reject(err: Error): void;
}

export interface ConfirmPrompt extends BasePrompt {
  readonly kind: 'confirm';
  resolve(value: boolean): void;
  reject(err: Error): void;
}

export interface ChoicePrompt<T = unknown> extends BasePrompt {
  readonly kind: 'choice';
  readonly options: ReadonlyArray<Choice<T>>;
  resolve(value: T): void;
  reject(err: Error): void;
}

export interface MultiChoicePrompt<T = unknown> extends BasePrompt {
  readonly kind: 'multi-choice';
  readonly options: ReadonlyArray<Choice<T>>;
  resolve(value: readonly T[]): void;
  reject(err: Error): void;
}

export type PendingPrompt = TextPrompt | TextAreaPrompt | ConfirmPrompt | ChoicePrompt | MultiChoicePrompt;

/**
 * Distributive `Omit` over the prompt union — preserves the discriminant so each variant's
 * input shape stays narrowable. `Omit<PendingPrompt, 'id'>` would collapse the union to a
 * structural intersection where the per-variant `options` field is invisible to the caller.
 */
export type PendingPromptInput =
  | Omit<TextPrompt, 'id'>
  | Omit<TextAreaPrompt, 'id'>
  | Omit<ConfirmPrompt, 'id'>
  | Omit<ChoicePrompt, 'id'>
  | Omit<MultiChoicePrompt, 'id'>;

type Listener = () => void;

export interface PromptQueue {
  readonly head: PendingPrompt | undefined;
  readonly size: number;
  enqueue(prompt: PendingPromptInput): PendingPrompt;
  /** Resolve the head with `value` and slide to the next. No-op if the queue is empty. */
  resolveHead(value: unknown): void;
  /** Reject the head with `err` and slide to the next. No-op if the queue is empty. */
  rejectHead(err: Error): void;
  /** Subscribe to changes (head replaced / queue length changed). */
  subscribe(fn: Listener): () => void;
  /** Reject every queued prompt with `err`. Used on shutdown. */
  drain(err: Error): void;
}

export const createPromptQueue = (): PromptQueue => {
  let nextId = 1;
  const queue: PendingPrompt[] = [];
  const listeners = new Set<Listener>();

  const notify = (): void => {
    for (const fn of [...listeners]) fn();
  };

  return {
    get head(): PendingPrompt | undefined {
      return queue[0];
    },
    get size(): number {
      return queue.length;
    },
    enqueue(prompt): PendingPrompt {
      const id = nextId++;
      const full = { ...prompt, id } as PendingPrompt;
      queue.push(full);
      notify();
      return full;
    },
    resolveHead(value): void {
      const head = queue.shift();
      if (!head) return;
      try {
        // Type-narrow before dispatch so each kind sees the right value shape.
        switch (head.kind) {
          case 'text':
            head.resolve(value as string);
            break;
          case 'textarea':
            head.resolve(value as string);
            break;
          case 'confirm':
            head.resolve(value as boolean);
            break;
          case 'choice':
            head.resolve(value);
            break;
          case 'multi-choice':
            head.resolve(value as readonly unknown[]);
            break;
        }
      } finally {
        notify();
      }
    },
    rejectHead(err): void {
      const head = queue.shift();
      if (!head) return;
      try {
        head.reject(err);
      } finally {
        notify();
      }
    },
    subscribe(fn): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    drain(err): void {
      while (queue.length > 0) {
        const p = queue.shift();
        try {
          p?.reject(err);
        } catch {
          // listener-style: a bad reject handler must not stall draining.
        }
      }
      notify();
    },
  };
};
