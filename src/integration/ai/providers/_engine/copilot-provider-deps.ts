import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

/**
 * Composition-root inputs for the Copilot headless provider adapter. Lives in `_engine/` so the
 * concrete `copilot/headless.ts` factory + tests can both depend on a port-shaped contract
 * without piercing the sibling-isolation rule.
 *
 * See `copilot/headless.ts` for the runtime translation table from these knobs to Copilot CLI
 * flags.
 */
export interface CopilotProviderDeps {
  readonly rateLimitRetries: number;
  readonly eventBus: EventBus;
  readonly spawn?: ProviderSpawn;
  /** Test seam: overrides the executable name. Defaults to `'copilot'`. */
  readonly command?: string;
  /**
   * Milliseconds of stdio silence before the adapter SIGTERMs a wedged child. Defaults to
   * `DEFAULT_IDLE_MS` (5 min). Lower in tests to exercise the watchdog path.
   */
  readonly idleMs?: number;
  /**
   * Wait schedule between rate-limit retries. Defaults to `DEFAULT_BACKOFF_SCHEDULE`. Tests
   * pass `[0, 0, …]` to skip the waits.
   */
  readonly backoffSchedule?: readonly number[];
}
