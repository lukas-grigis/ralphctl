import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Mark the task in_progress (if not already) and emit a `task-started`
 * event on the signal bus.
 *
 * The persistence update is idempotent — skipped when the task is already
 * in_progress (e.g. resuming after a rate-limit pause or crash).
 *
 * The signal bus is provided through this step's `deps` closure; the
 * scheduler keeps it off the per-item context.
 */
export function markInProgress(deps: {
  persistence: PersistencePort;
  signalBus: SignalBusPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('mark-in-progress', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;

    try {
      if (task.status !== 'in_progress') {
        await deps.persistence.updateTaskStatus(task.id, 'in_progress', sprint.id);
      }
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to mark task in_progress: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }

    deps.signalBus.emit({
      type: 'task-started',
      sprintId: sprint.id,
      taskId: task.id,
      taskName: task.name,
      timestamp: new Date(),
    });

    const empty: Partial<PerTaskContext> = {};
    return Result.ok(empty) as DomainResult<Partial<PerTaskContext>>;
  });
}
