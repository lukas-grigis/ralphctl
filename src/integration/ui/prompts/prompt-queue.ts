/**
 * Module-level queue bridging the synchronous `PromptPort` API and the
 * asynchronous React-rendered prompts of the Ink app.
 *
 * Flow:
 *  1. Command calls `getPrompt().confirm({...})` (InkPromptAdapter).
 *  2. InkPromptAdapter enqueues a PendingPrompt carrying the options and
 *     the promise's resolve/reject callbacks.
 *  3. `<PromptHost />` subscribes to the queue, renders the head prompt
 *     using the appropriate component, and calls `resolveCurrent(value)`
 *     or `cancelCurrent(err)` when the user acts.
 *  4. Next prompt in the queue renders, or nothing if empty.
 *
 * Mutex behaviour: only the head prompt renders. Parallel `confirm`/`select`
 * calls queue up and render one at a time. This matches user expectation —
 * two modals on screen simultaneously would be unusable.
 */

import type {
  CheckboxOptions,
  ConfirmOptions,
  EditorOptions,
  FileBrowserOptions,
  InputOptions,
  SelectOptions,
} from '@src/business/ports/prompt.ts';

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

type Listener = (current: PendingPrompt | null) => void;

class PromptQueue {
  private readonly queue: PendingPrompt[] = [];
  private readonly listeners = new Set<Listener>();

  enqueue(prompt: PendingPrompt): void {
    this.queue.push(prompt);
    this.notify();
  }

  current(): PendingPrompt | null {
    return this.queue[0] ?? null;
  }

  resolveCurrent(value: unknown): void {
    const head = this.queue.shift();
    if (!head) return;
    // The switch in the caller already narrowed to the expected kind; the
    // cast is safe because InkPromptAdapter + <PromptHost /> agree on shape.
    (head.resolve as (v: unknown) => void)(value);
    this.notify();
  }

  cancelCurrent(err: Error): void {
    const head = this.queue.shift();
    if (!head) return;
    head.reject(err);
    this.notify();
  }

  /** Drop all pending prompts without resolving. Used on app shutdown. */
  clear(reason: Error): void {
    while (this.queue.length > 0) {
      const p = this.queue.shift();
      p?.reject(reason);
    }
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.queue.length;
  }

  private notify(): void {
    const curr = this.current();
    for (const l of this.listeners) {
      try {
        l(curr);
      } catch {
        // Listener errors must not stall the queue.
      }
    }
  }
}

export const promptQueue = new PromptQueue();
