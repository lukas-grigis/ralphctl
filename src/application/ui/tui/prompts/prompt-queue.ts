/**
 * Module-level prompt queue that bridges chain code awaiting `interactive.askConfirm(...)` into the React tree: each
 * ask enqueues and returns a Promise, `<PromptHost>` renders only the head, and resolving it slides the next one in.
 */

import type { Choice } from '@src/business/interactive/prompt.ts';

export type PromptKind = 'text' | 'textarea' | 'confirm' | 'choice' | 'multi-choice';

export interface BasePrompt {
  readonly id: number;
  readonly kind: PromptKind;
  readonly message: string;
  /** Run that asked — stamped by the Ink adapter from the session scope; absent for view-local asks. */
  readonly sessionId?: string;
  /** Epoch ms the prompt was queued — stamped by `enqueue`. */
  readonly askedAt?: number;
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
  /** Values to pre-check on open — surfaced to the renderer as `initialSelectedValues`. */
  readonly initial?: readonly T[];
  resolve(value: readonly T[]): void;
  reject(err: Error): void;
}

export type PendingPrompt = TextPrompt | TextAreaPrompt | ConfirmPrompt | ChoicePrompt | MultiChoicePrompt;

/**
 * Distributive `Omit` over the prompt union — preserves the discriminant so each variant's input shape stays
 * narrowable.
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
  /** Every queued prompt, head first. */
  readonly pending: readonly PendingPrompt[];
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
    get pending(): readonly PendingPrompt[] {
      return [...queue];
    },
    get size(): number {
      return queue.length;
    },
    enqueue(prompt): PendingPrompt {
      const id = nextId++;
      const full = { ...prompt, id, askedAt: Date.now() } as PendingPrompt;
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
