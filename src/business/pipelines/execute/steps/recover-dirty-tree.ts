import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { recoverDirtyTree as recoverDirtyTreeCore } from '@src/business/usecases/recover-dirty-tree.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Pipeline step wrapper around the shared `recoverDirtyTree` helper. See
 * `src/business/usecases/recover-dirty-tree.ts` for the behavioural contract
 * — this step just resolves the repo path and forwards to the helper.
 */
export function recoverDirtyTree(deps: {
  persistence: PersistencePort;
  external: ExternalPort;
  logger: LoggerPort;
  signalBus: SignalBusPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('recover-dirty-tree', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;
    const repoPath = await deps.persistence.resolveRepoPath(task.repoId);

    await recoverDirtyTreeCore(
      { external: deps.external, logger: deps.logger, signalBus: deps.signalBus },
      { sprintId: sprint.id, taskId: task.id, taskName: task.name, repoPath }
    );

    return Result.ok({});
  });
}
