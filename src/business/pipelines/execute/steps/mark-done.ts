import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Terminal success step: mark the task `done`, emit `task-finished`, and
 * append a progress log entry. Mirrors the sequential/parallel executor's
 * tail — same log lines, same signal-bus event, same progress payload.
 */
export function markDone(deps: {
  persistence: PersistencePort;
  logger: LoggerPort;
  signalBus: SignalBusPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('mark-done', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;

    try {
      await deps.persistence.updateTaskStatus(task.id, 'done', sprint.id);
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to mark task done: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }

    deps.logger.success(`Completed: ${task.name}`);
    deps.signalBus.emit({
      type: 'task-finished',
      sprintId: sprint.id,
      taskId: task.id,
      status: 'done',
      timestamp: new Date(),
    });

    try {
      const repoPath = await deps.persistence.resolveRepoPath(task.repoId).catch(() => null);
      await deps.persistence.logProgress(`Completed task: ${task.id} - ${task.name}`, {
        sprintId: sprint.id,
        ...(repoPath ? { projectPath: repoPath } : {}),
      });
    } catch (err) {
      // Progress logging is best-effort — don't fail the pipeline here.
      deps.logger.warning(
        `Progress log write failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const empty: Partial<PerTaskContext> = {};
    return Result.ok(empty) as DomainResult<Partial<PerTaskContext>>;
  });
}
