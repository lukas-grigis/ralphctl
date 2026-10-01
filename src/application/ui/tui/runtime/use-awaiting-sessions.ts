/** Runs currently blocked on an operator answer, derived from the prompt queue: session id → waiting since (epoch ms). */

import { useEffect, useState } from 'react';
import { useOptionalPromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';

const EMPTY: ReadonlyMap<string, number> = new Map();

export const awaitingSessions = (queue: Pick<PromptQueue, 'pending'>): ReadonlyMap<string, number> => {
  const since = new Map<string, number>();
  for (const { sessionId, askedAt } of queue.pending) {
    if (sessionId !== undefined && !since.has(sessionId)) since.set(sessionId, askedAt ?? Date.now());
  }
  return since.size === 0 ? EMPTY : since;
};

const same = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([id, at]) => b.get(id) === at);

export const useAwaitingSessions = (): ReadonlyMap<string, number> => {
  const queue = useOptionalPromptQueue();
  const [waiting, setWaiting] = useState<ReadonlyMap<string, number>>(() => (queue ? awaitingSessions(queue) : EMPTY));

  useEffect(() => {
    if (!queue) return undefined;
    const sync = (): void => {
      const next = awaitingSessions(queue);
      setWaiting((prev) => (same(prev, next) ? prev : next));
    };
    sync();
    return queue.subscribe(sync);
  }, [queue]);

  return waiting;
};
