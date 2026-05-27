import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Composition-root inputs for {@link createCodexSkillsAdapter}. Shape mirrors the claude and
 * copilot variants; lives in `_engine/` so each per-tool adapter file imports a port-shaped
 * contract instead of declaring its inputs next to the implementation.
 */
export interface CreateCodexSkillsAdapterDeps {
  readonly logger?: Logger;
}
