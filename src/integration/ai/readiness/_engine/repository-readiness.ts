import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';

/**
 * Composite per-repository view across every assistant tool the harness knows about. A missing
 * key in `perTool` is equivalent to `{ kind: 'unknown' }` — the dictionary is sparse so that
 * adding a new tool doesn't force every existing record to grow.
 */
export interface RepositoryReadiness {
  readonly repositoryId: RepositoryId;
  readonly perTool: Readonly<Partial<Record<AssistantTool, ReadinessState>>>;
}
