import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Composition-root inputs for the {@link createSkillsAdapter} factory. Lives in `_engine/` so
 * the factory plus future call sites consume a port-shaped contract, not a sibling-private
 * shape declared next to the implementation.
 */
export interface SkillsAdapterFactoryDeps {
  readonly provider: AiProvider;
  /** Optional logger — surfaces best-effort `.git/info/exclude` write failures as warnings. */
  readonly logger?: Logger;
}
