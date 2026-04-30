/**
 * React hooks for the prompt layer.
 *
 * `<PromptHost />` uses `useCurrentPrompt()` to decide which prompt component
 * to render. Kept separate from TUI runtime hooks so the prompt layer does not
 * depend on the full Ink dashboard tree.
 */

import { useEffect, useState } from 'react';
import { promptQueue, type PendingPrompt, type PromptQueueState, type ResolvedPrompt } from './prompt-queue.ts';

/**
 * Subscribe to the prompt queue's head pending prompt.
 */
export function useCurrentPrompt(): PendingPrompt | null {
  const [current, setCurrent] = useState<PendingPrompt | null>(null);

  useEffect(() => {
    const unsubscribe = promptQueue.subscribe((state) => {
      setCurrent(state.current);
    });
    return unsubscribe;
  }, []);

  return current;
}

/**
 * Subscribe to the prompt queue's full state — current pending prompt plus
 * the history of resolved prompts in the active sequence. `<PromptHost />`
 * reads both so it can render past answers as a dim transcript above the
 * live prompt.
 */
export function usePromptState(): PromptQueueState {
  const [state, setState] = useState<PromptQueueState>({ current: null, history: [] });

  useEffect(() => {
    const unsubscribe = promptQueue.subscribe(setState);
    return unsubscribe;
  }, []);

  return state;
}

export type { ResolvedPrompt };
