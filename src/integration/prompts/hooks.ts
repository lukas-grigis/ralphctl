/**
 * React hooks for the prompt layer.
 *
 * `<PromptHost />` uses `useCurrentPrompt()` to decide which prompt component
 * to render. Kept separate from TUI runtime hooks so the prompt layer does not
 * depend on the full Ink dashboard tree.
 */

import { useEffect, useState } from 'react';
import { promptQueue, type PendingPrompt } from './prompt-queue.ts';

/**
 * Subscribe to the prompt queue's head pending prompt.
 */
export function useCurrentPrompt(): PendingPrompt | null {
  const [current, setCurrent] = useState<PendingPrompt | null>(null);

  useEffect(() => {
    const unsubscribe = promptQueue.subscribe(setCurrent);
    return unsubscribe;
  }, []);

  return current;
}
