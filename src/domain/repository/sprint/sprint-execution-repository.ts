import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';

/**
 * Persistence port for the `SprintExecution` aggregate. Paired 1:1 with `Sprint` via the
 * shared `SprintId`. There is no `ListAll` capability — executions are always accessed via
 * their parent sprint, never enumerated standalone.
 */
export interface SprintExecutionRepository
  extends FindById<SprintExecution, SprintId>, Save<SprintExecution>, Remove<SprintId> {}
