import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

/**
 * Composition-root inputs for the Claude interactive provider adapter. Lives in `_engine/`
 * so the concrete `claude/interactive.ts` factory + tests can both depend on a port-shaped
 * contract without piercing the sibling-isolation rule.
 */
export interface InteractiveClaudeDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the binary name for tests / packaging. Defaults to `'claude'`. */
  readonly command?: string;
  /**
   * Test seam: generate the UUID passed to Claude's `--session-id <uuid>` flag. Production
   * uses {@link uuidv7}; tests stub a deterministic value so argv assertions stay stable.
   */
  readonly newSessionId?: () => string;
}
