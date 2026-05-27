import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

/**
 * Composition-root inputs for the Codex interactive provider adapter. Lives in `_engine/`
 * so the concrete `codex/interactive.ts` factory + tests can both depend on a port-shaped
 * contract without piercing the sibling-isolation rule.
 */
export interface InteractiveCodexDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the shell name for tests / packaging. Defaults to `'bash'`. */
  readonly command?: string;
}
