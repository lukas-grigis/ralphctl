import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

/**
 * Composition-root inputs for the Copilot interactive provider adapter. Lives in `_engine/`
 * so the concrete `copilot/interactive.ts` factory + tests can both depend on a port-shaped
 * contract without piercing the sibling-isolation rule.
 */
export interface InteractiveCopilotDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the binary name for tests / packaging. Defaults to `'copilot'`. */
  readonly command?: string;
  /** Test seam for prompt-file reads. Defaults to `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<string>;
  /**
   * Test seam: generate the UUID passed to Copilot's `--session-id=<uuid>` flag. Production
   * uses {@link uuidv7}; tests stub a deterministic value so argv assertions stay stable.
   */
  readonly newSessionId?: () => string;
}
