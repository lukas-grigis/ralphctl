import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

/**
 * Composition-root inputs for the Codex headless provider adapter. Lives in `_engine/` so the
 * concrete `codex/headless.ts` factory + tests can both depend on a port-shaped contract
 * without piercing the sibling-isolation rule.
 *
 * See `codex/headless.ts` for the runtime translation table from these knobs to Codex CLI
 * argv.
 */
export interface CodexProviderDeps {
  readonly rateLimitRetries: number;
  readonly eventBus: EventBus;
  readonly spawn?: ProviderSpawn;
  /** Test seam: overrides the executable name. Defaults to `'codex'`. */
  readonly command?: string;
  /** Test seam: read the captured tempfile. Defaults to `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Test seam: delete the captured tempfile. Defaults to `fs.unlink` (best-effort). */
  readonly unlink?: (path: string) => Promise<void>;
  /** Test seam: pick the tempfile path. Defaults to `os.tmpdir()/ralphctl-codex-<n>.txt`. */
  readonly mkTempPath?: () => string;
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
