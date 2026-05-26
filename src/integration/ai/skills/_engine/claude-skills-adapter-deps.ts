import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Composition-root inputs for {@link createClaudeSkillsAdapter}. Shape mirrors the codex and
 * copilot variants; lives in `_engine/` so each per-tool adapter file imports a port-shaped
 * contract instead of declaring its inputs next to the implementation.
 */
export interface CreateClaudeSkillsAdapterDeps {
  readonly logger?: Logger;
}
