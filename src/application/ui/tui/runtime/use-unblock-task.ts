/**
 * `useUnblockTask` — the runtime seam every view uses to revive stuck tasks, shaped like
 * {@link useLaunchCreateSprint}: the hook closes over `useDeps()` and assembles the use case's
 * argument once, so a view supplies only what it knows (the task(s), the sprint, the project).
 *
 * Manual unblock has no registered flow — it is a repository write with no chain and no trace, so a
 * runtime hook is the sanctioned shape (DESIGN-SYSTEM §9). The one thing it adds is the prior-work
 * question: when git holds the task's quarantined rejected diff, the operator decides what the next
 * attempt does with it, asked through the prompt queue before anything is written.
 *
 * The hook owns no toast copy — post-write concerns (mounted guards, feedback, reloads) stay in the view.
 *
 * @public
 */

import { useCallback, useMemo } from 'react';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useOptionalPromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { unblockTaskUseCase, type UnblockTaskOutput } from '@src/business/task/unblock-task.ts';
import {
  askBulkPriorWork,
  askPriorWork,
  probeTaskQuarantine,
  type QuarantineProbe,
} from '@src/application/ui/shared/prior-work.ts';
import type { PriorWorkDecision } from '@src/domain/entity/task-prior-work.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

export type UnblockOneResult =
  | { readonly kind: 'unblocked'; readonly output: UnblockTaskOutput; readonly probe: QuarantineProbe }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: InvalidStateError | NotFoundError | StorageError };

export type UnblockManyResult =
  | {
      readonly kind: 'done';
      readonly results: ReadonlyArray<{ readonly task: Task; readonly result: UnblockOneResult }>;
    }
  | { readonly kind: 'cancelled' };

export interface UnblockTasks {
  readonly unblockOne: (task: Task, sprint: Sprint, project: Project | undefined) => Promise<UnblockOneResult>;
  /** `unblockOne` for a caller that holds only the sprint id (the Execute panel): loads sprint + project first. */
  readonly unblockInSprint: (task: Task, sprintId: SprintId) => Promise<UnblockOneResult>;
  readonly unblockMany: (
    tasks: readonly Task[],
    sprint: Sprint,
    project: Project | undefined
  ) => Promise<UnblockManyResult>;
}

/** A `todo` task has nothing to decide: only the use case's interrupted-reopen finish applies. */
const mayHoldStash = (task: Task): boolean => task.status === 'blocked' || task.status === 'in_progress';

export const useUnblockTask = (): UnblockTasks => {
  const deps = useDeps();
  // The App always mounts a queue; a bare view render (no provider) has no way to ask, so it never probes.
  const queue = useOptionalPromptQueue();
  const interactive = useMemo(
    () => (queue !== undefined ? createInkInteractivePrompt(queue, deps.eventBus) : undefined),
    [queue, deps.eventBus]
  );

  const run = useCallback(
    async (
      task: Task,
      sprint: Sprint,
      probe: QuarantineProbe,
      priorWork?: PriorWorkDecision
    ): Promise<UnblockOneResult> => {
      const r = await unblockTaskUseCase({
        task,
        sprintId: sprint.id,
        taskRepo: deps.taskRepo,
        sprintRepo: deps.sprintRepo,
        clock: deps.clock,
        logger: deps.logger,
        ...(priorWork !== undefined ? { priorWork } : {}),
      });
      return r.ok ? { kind: 'unblocked', output: r.value, probe } : { kind: 'failed', error: r.error };
    },
    [deps]
  );

  const unblockOne = useCallback(
    async (task: Task, sprint: Sprint, project: Project | undefined): Promise<UnblockOneResult> => {
      const probe: QuarantineProbe =
        interactive !== undefined && mayHoldStash(task)
          ? await probeTaskQuarantine(deps, project, sprint.id, task)
          : { kind: 'none' };
      if (interactive === undefined || probe.kind !== 'present') return run(task, sprint, probe);
      const asked = await askPriorWork(interactive, task, probe);
      if (asked.value === 'cancelled') return { kind: 'cancelled' };
      return run(task, sprint, probe, asked.value);
    },
    [deps, interactive, run]
  );

  const unblockInSprint = useCallback(
    async (task: Task, sprintId: SprintId): Promise<UnblockOneResult> => {
      const sprint = await deps.sprintRepo.findById(sprintId);
      if (!sprint.ok) return { kind: 'failed', error: sprint.error };
      const project = await deps.projectRepo.findById(sprint.value.projectId);
      return unblockOne(task, sprint.value, project.ok ? project.value : undefined);
    },
    [deps, unblockOne]
  );

  const unblockMany = useCallback(
    async (tasks: readonly Task[], sprint: Sprint, project: Project | undefined): Promise<UnblockManyResult> => {
      const rows = await Promise.all(
        tasks.map(async (task) => ({
          task,
          probe:
            interactive !== undefined && mayHoldStash(task)
              ? await probeTaskQuarantine(deps, project, sprint.id, task)
              : ({ kind: 'none' } as const),
        }))
      );
      const asked = interactive !== undefined ? await askBulkPriorWork(interactive, rows, tasks.length) : undefined;
      if (asked?.value === 'cancelled') return { kind: 'cancelled' };
      const decisions = asked?.value ?? new Map<string, PriorWorkDecision>();
      const results: Array<{ task: Task; result: UnblockOneResult }> = [];
      for (const { task, probe } of rows) {
        results.push({ task, result: await run(task, sprint, probe, decisions.get(String(task.id))) });
      }
      return { kind: 'done', results };
    },
    [deps, interactive, run]
  );

  return { unblockOne, unblockInSprint, unblockMany };
};
