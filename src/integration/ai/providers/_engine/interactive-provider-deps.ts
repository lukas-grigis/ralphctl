import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InteractiveSpawn } from '@src/integration/ai/providers/_engine/interactive-spawn.ts';

/**
 * Composition-root inputs shared by every interactive provider adapter (claude / codex /
 * copilot). Lives in `_engine/` so each concrete `<tool>/interactive.ts` factory and its tests
 * depend on one port-shaped contract without piercing the sibling-isolation rule.
 *
 * The three per-tool copies were byte-identical apart from the default binary name (which is
 * spec data, not a dep) and `newSessionId` (which Codex never reads — its interactive command
 * has no launch-time session-id override, so the field is simply unused there).
 */
export interface InteractiveProviderDeps {
  readonly eventBus: EventBus;
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: InteractiveSpawn;
  /** Override the binary name for tests / packaging. Defaults to the adapter's own CLI name. */
  readonly command?: string;
  /** Test seam for prompt-file reads. Defaults to `fs.readFile`. */
  readonly readFile?: (path: string) => Promise<string>;
  /**
   * Test seam: generate the UUID passed to the CLI's session-id flag. Production uses
   * {@link uuidv7}; tests stub a deterministic value so argv assertions stay stable. Ignored by
   * adapters whose CLI accepts no launch-time session id.
   */
  readonly newSessionId?: () => string;
}
