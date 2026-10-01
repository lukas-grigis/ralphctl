// Retention audit: BOUNDED — `TOKEN_USAGE_SESSION_CAP = 100` enforces an LRU on the per-sessionId Map.

/**
 * Per-session token-usage tracker — subscribes to `TokenUsageEvent` on the EventBus and folds the latest emission per
 * `sessionId` into a `Map<sessionId, TokenUsage>`.
 */

import type { AppEvent, TokenUsageEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useCoalescedMap } from '@src/application/ui/tui/runtime/use-coalesced-map.ts';

/** Hard cap on retained per-session token-usage entries. */
const TOKEN_USAGE_SESSION_CAP = 100;

export interface TokenUsage {
  readonly provider: TokenUsageEvent['provider'];
  readonly model?: string;
  // Cumulative throughput / billing figures (sum across all turns of a claude -p spawn).
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  // Live per-turn snapshot (last assistant turn) — true current context-window occupancy.
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
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
  ...(e.liveInputTokens !== undefined ? { liveInputTokens: e.liveInputTokens } : {}),
  ...(e.liveCacheReadTokens !== undefined ? { liveCacheReadTokens: e.liveCacheReadTokens } : {}),
  ...(e.liveCacheCreationTokens !== undefined ? { liveCacheCreationTokens: e.liveCacheCreationTokens } : {}),
  ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
});

// Key by the chain runner id when present — that is the id the execute view looks up by.
const keyOfTokenUsage = (e: TokenUsageEvent): string => e.chainSessionId ?? e.sessionId;

// Latest event always wins per key — no monotonic guard, so the fold ignores `existing`.
const foldTokenUsage = (_existing: TokenUsage | undefined, e: TokenUsageEvent): TokenUsage => toUsage(e);

/** @public */
export interface UseTokenUsageOptions {
  /** Flush cadence in ms. Test-only escape hatch; production callers use the coalescer default. */
  readonly flushMs?: number;
}

/** Subscribe to `token-usage` events on `bus` and return the latest usage per sessionId. */
export const useTokenUsage = (bus: EventBus, opts: UseTokenUsageOptions = {}): ReadonlyMap<string, TokenUsage> =>
  useCoalescedMap<TokenUsageEvent, TokenUsage>(bus, {
    cap: TOKEN_USAGE_SESSION_CAP,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    accept: isTokenUsage,
    keyOf: keyOfTokenUsage,
    fold: foldTokenUsage,
  });
