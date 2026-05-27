import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

/**
 * Composition-root inputs for the Claude headless provider adapter. Lives in `_engine/` so the
 * concrete `claude/headless.ts` factory + tests can both depend on a port-shaped contract
 * without piercing the sibling-isolation rule (the per-tool `claude/` directory cannot be
 * reached into from elsewhere; `_engine/` is the shared seam).
 *
 * See `claude/headless.ts` for the runtime translation table from these knobs to Claude CLI
 * flags.
 */
export interface ClaudeProviderDeps {
  /** Adapter-side retries on `RateLimitError` before surfacing the failure. */
  readonly rateLimitRetries: number;
  /** Sink for adapter-level logs (session id capture, retries, raw lines at debug level). */
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: ProviderSpawn;
  /**
   * Test seam: overrides the executable name. Defaults to `'claude'` so the binary must be on
   * `$PATH` (vendoring is a follow-up — see decision log).
   */
  readonly command?: string;
  /**
   * Milliseconds of stdio silence before the adapter SIGTERMs a wedged child. Defaults to
   * `DEFAULT_IDLE_MS` (5 min). Real sessions stream tokens continuously; this only fires on
   * truly stuck children. Surface as an opt-in to keep tests fast (lower the threshold to a
   * few ms to exercise the watchdog path).
   */
  readonly idleMs?: number;
  /**
   * Wait schedule between rate-limit retries, in ms. Defaults to `DEFAULT_BACKOFF_SCHEDULE`
   * (1 min → 5 min → 30 min → 2 h). Tests pass `[0, 0, …]` to keep retry assertions fast.
   */
  readonly backoffSchedule?: readonly number[];
}
