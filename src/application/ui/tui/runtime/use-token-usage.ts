// Retention audit: BOUNDED — `TOKEN_USAGE_SESSION_CAP = 100` enforces an LRU on the per-sessionId
// Map. Each entry is a small `TokenUsage` value object (~100 bytes: provider/model strings plus a
// handful of numbers), so the cap pins memory at roughly 10 KB regardless of session count. Sound
// because every insert path goes through the same delete-then-set-then-evict reducer, and the
// TokenBudgetCard only ever reads the most recent session anyway — evicted entries are unread.

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
 * React consumers re-render on every change. Unlike the round tracker (keyed by stable
 * `taskId`), the token-usage Map is keyed by per-spawn `sessionId` and so is capped at
 * {@link TOKEN_USAGE_SESSION_CAP} entries (LRU on insertion order) — a long Implement run with
 * many rounds × tasks × rate-limit retries could otherwise grow the Map unboundedly.
 */

import { useEffect, useState } from 'react';
import type { AppEvent, TokenUsageEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/**
 * Hard cap on retained per-session token-usage entries. Each entry is small (~100 bytes) but
 * the keying is per-spawn (sessionId comes from the AI CLI's `system.init` event), so a
 * multi-hundred-round implement run can accumulate hundreds of sessions across the TUI's
 * lifetime. 100 keeps roughly the most recent runner's worth of spawns hot for display while
 * preventing the Map from becoming a slow leak — the TokenBudgetCard only ever reads the
 * current session, so dropping stale entries is harmless.
 */
const TOKEN_USAGE_SESSION_CAP = 100;

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
 */
export const useTokenUsage = (bus: EventBus): ReadonlyMap<string, TokenUsage> => {
  const [usage, setUsage] = useState<ReadonlyMap<string, TokenUsage>>(() => new Map());

  useEffect(() => {
    return bus.subscribe((event) => {
      if (!isTokenUsage(event)) return;
      // Key by the chain runner id when present — that is the id the execute view looks up by.
      // Provider adapters stamp `sessionId` with the AI CLI's own uuid (a disjoint id space), so
      // keying on it alone guarantees a miss. Legacy / one-shot events without a runner id fall
      // back to `sessionId` so they still resolve.
      const key = event.chainSessionId ?? event.sessionId;
      setUsage((prev) => {
        const next = new Map(prev);
        // Delete + re-set so an updated session jumps to the end of insertion order; the LRU
        // eviction below then drops the actually-oldest entry, not whichever key hashed
        // first in Map's insertion order.
        next.delete(key);
        next.set(key, toUsage(event));
        while (next.size > TOKEN_USAGE_SESSION_CAP) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    });
  }, [bus]);

  return usage;
};
