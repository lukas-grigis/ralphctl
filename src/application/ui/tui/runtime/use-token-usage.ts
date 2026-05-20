/**
 * Per-session token-usage tracker — subscribes to `TokenUsageEvent` on the EventBus and folds
 * the latest emission per `sessionId` into a `Map<sessionId, TokenUsage>`. Latest event wins
 * (token counts are reported once per provider spawn, but a session may span multiple spawns —
 * the most recent figure is what the operator wants to see).
 *
 * Why a hook and not a one-shot subscription: the Implement dashboard mounts long after the
 * first spawn for a multi-task sprint, and stays mounted across subsequent spawns. We need a
 * live updating map that re-renders consumers on each publish; the hook keeps the bookkeeping
 * out of the view.
 *
 * Mirrors {@link useTaskRoundTracker} — same Map-per-update referential-equality pattern so
 * React consumers re-render on every change.
 */

import { useEffect, useState } from 'react';
import type { AppEvent, TokenUsageEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/** @public */
export interface TokenUsage {
  readonly provider: TokenUsageEvent['provider'];
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly contextWindow?: number;
}

const isTokenUsage = (e: AppEvent): e is TokenUsageEvent => e.type === 'token-usage';

const toUsage = (e: TokenUsageEvent): TokenUsage => ({
  provider: e.provider,
  ...(e.model !== undefined ? { model: e.model } : {}),
  ...(e.inputTokens !== undefined ? { inputTokens: e.inputTokens } : {}),
  ...(e.outputTokens !== undefined ? { outputTokens: e.outputTokens } : {}),
  ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
  ...(e.cacheCreationTokens !== undefined ? { cacheCreationTokens: e.cacheCreationTokens } : {}),
  ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
});

/**
 * Subscribe to `token-usage` events on `bus` and return the latest usage per sessionId. Returns
 * a fresh Map on every update so React's referential equality check triggers re-renders.
 * @public
 */
export const useTokenUsage = (bus: EventBus): ReadonlyMap<string, TokenUsage> => {
  const [usage, setUsage] = useState<ReadonlyMap<string, TokenUsage>>(() => new Map());

  useEffect(() => {
    const unsub = bus.subscribe((event) => {
      if (!isTokenUsage(event)) return;
      setUsage((prev) => {
        const next = new Map(prev);
        next.set(event.sessionId, toUsage(event));
        return next;
      });
    });
    return unsub;
  }, [bus]);

  return usage;
};
