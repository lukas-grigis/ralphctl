/**
 * Module-level queue bridging the synchronous PromptPort API and the
 * asynchronous React-rendered prompts of the Ink app.
 *
 * Flow:
 *  1. Command calls getPrompt().confirm({...}) → InkPromptAdapter.
 *  2. InkPromptAdapter enqueues a PendingPrompt carrying options + callbacks.
 *  3. <PromptHost /> subscribes, renders the head prompt, calls
 *     resolveCurrent(value) or cancelCurrent(err) when the user acts.
 *  4. Next prompt in queue renders, or nothing if empty.
 *
 * Mutex behaviour: only the head prompt renders at a time. Parallel calls
 * queue and render one at a time — two modals on screen simultaneously would
 * be unusable.
 *
 * Ported from src/integration/ui/prompts/prompt-queue.ts — no legacy src/ imports.
 */

import type {
  CheckboxOptions,
  ConfirmOptions,
  EditorOptions,
  FileBrowserOptions,
  InputOptions,
  SelectOptions,
} from '../../../business/ports/prompt-port.ts';

// Using `unknown` inside the union keeps the queue monomorphic; InkPromptAdapter
// casts generics at the call boundary where the type information is still known.
export type PendingPrompt =
  | {
      kind: 'select';
      options: SelectOptions<unknown>;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'confirm';
      options: ConfirmOptions;
      resolve: (value: boolean) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'input';
      options: InputOptions;
      resolve: (value: string) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'checkbox';
      options: CheckboxOptions<unknown>;
      resolve: (value: unknown[]) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'editor';
      options: EditorOptions;
      resolve: (value: string | null) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'fileBrowser';
      options: FileBrowserOptions;
      resolve: (value: string | null) => void;
      reject: (err: Error) => void;
    };

/**
 * A resolved prompt kept as transcript so the UI can render past answers
 * dimmed above the active prompt instead of erasing them. Each entry carries
 * the original `kind` + `options` (so the renderer can reuse the same
 * formatter the live prompt component does) plus the answered value.
 */
export type ResolvedPrompt =
  | { kind: 'confirm'; options: ConfirmOptions; value: boolean }
  | { kind: 'input'; options: InputOptions; value: string }
  | { kind: 'select'; options: SelectOptions<unknown>; value: unknown }
  | { kind: 'checkbox'; options: CheckboxOptions<unknown>; value: readonly unknown[] }
  | { kind: 'editor'; options: EditorOptions; value: string | null }
  | { kind: 'fileBrowser'; options: FileBrowserOptions; value: string | null };

export interface PromptQueueState {
  readonly current: PendingPrompt | null;
  readonly history: readonly ResolvedPrompt[];
}

type Listener = (state: PromptQueueState) => void;

/**
 * Idle window before a new prompt is treated as the start of a fresh sequence.
 * Within this window, queued prompts contribute to the same transcript; past
 * the window, the next prompt clears the history first.
 */
const SEQUENCE_IDLE_MS = 100;

class PromptQueue {
  private readonly queue: PendingPrompt[] = [];
  private history: ResolvedPrompt[] = [];
  private lastResolveAt = 0;
  private readonly listeners = new Set<Listener>();

  enqueue(prompt: PendingPrompt): void {
    // Fresh sequence: the queue has been empty long enough that the next
    // prompt is a new transcript. Clear history before pushing so the user
    // sees only the current workflow's answers.
    if (this.queue.length === 0 && Date.now() - this.lastResolveAt > SEQUENCE_IDLE_MS) {
      this.history = [];
    }
    this.queue.push(prompt);
    this.notify();
  }

  current(): PendingPrompt | null {
    return this.queue[0] ?? null;
  }

  resolveCurrent(value: unknown): void {
    const head = this.queue.shift();
    if (!head) return;
    this.history.push(buildResolved(head, value));
    this.lastResolveAt = Date.now();
    (head.resolve as (v: unknown) => void)(value);
    this.notify();
  }

  cancelCurrent(err: Error): void {
    const head = this.queue.shift();
    if (!head) return;
    this.lastResolveAt = Date.now();
    head.reject(err);
    this.notify();
  }

  /** Drop all pending prompts without resolving. Used on app shutdown. */
  clear(reason: Error): void {
    while (this.queue.length > 0) {
      const p = this.queue.shift();
      p?.reject(reason);
    }
    this.history = [];
    this.notify();
  }

  /** Discard the visible transcript without affecting pending prompts. */
  clearHistory(): void {
    this.history = [];
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // Listener errors must not stall the queue.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.queue.length;
  }

  historySnapshot(): readonly ResolvedPrompt[] {
    return this.history;
  }

  private snapshot(): PromptQueueState {
    return { current: this.current(), history: this.history };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // Listener errors must not stall the queue.
      }
    }
  }
}

function buildResolved(prompt: PendingPrompt, value: unknown): ResolvedPrompt {
  switch (prompt.kind) {
    case 'confirm':
      return { kind: 'confirm', options: prompt.options, value: value as boolean };
    case 'input':
      return { kind: 'input', options: prompt.options, value: value as string };
    case 'select':
      return { kind: 'select', options: prompt.options, value };
    case 'checkbox':
      return { kind: 'checkbox', options: prompt.options, value: value as readonly unknown[] };
    case 'editor':
      return { kind: 'editor', options: prompt.options, value: value as string | null };
    case 'fileBrowser':
      return { kind: 'fileBrowser', options: prompt.options, value: value as string | null };
  }
}

export const promptQueue = new PromptQueue();
