import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Dependency gate — the per-task precondition that prevents the blocked-dependency dead-end.
 *
 * Tasks carry `dependsOn` edges; the scheduler orders dependents after their prerequisites but
 * is **status-blind** — it schedules a dependent whether its prerequisite settled `done` or
 * `blocked`. Without this gate a dependent of a blocked task ran anyway against a tree missing
 * the prerequisite's work and self-blocked: a cascade of doomed AI spawns masquerading as
 * independent failures, with the sprint silently shipping partial results.
 *
 * This leaf runs at the head of every per-task subchain (before `start-attempt`). It checks
 * whether every `dependsOn` task has settled `done`; if any prerequisite is not done (blocked,
 * or — defensively — still unsettled), it transitions THIS task straight to `blocked` with a
 * `blocked upstream …` reason and persists it. The body guard downstream then skips the whole
 * attempt loop, so no AI spawn is wasted. The transition is transitive by construction: if A
 * blocks, B (→A) blocks here, then C (→B) sees B blocked and blocks too.
 *
 * Recovery: unblocking the root prerequisite cascade-unblocks these upstream-blocked dependents
 * (see `unblock-task` use case), so the operator fixes one task and relaunches rather than
 * hand-unblocking the whole subtree.
 *
 * No-op fast paths: a task with no `dependsOn`, a task already settled (a relaunch re-entering a
 * blocked task), or all-prerequisites-done all return `Result.ok({})` leaving ctx untouched.
 */
export interface DependencyGateLeafDeps {
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

interface DependencyGateInput {
  readonly tasks: readonly Task[];
  readonly sprintId: SprintId;
}

interface DependencyGateOutput {
  /** The newly-blocked task when a prerequisite was not done; absent on every no-op path. */
  readonly blocked?: BlockedTask;
}

export const dependencyGateLeaf = (deps: DependencyGateLeafDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, DependencyGateInput, DependencyGateOutput>(`dependency-gate-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<DependencyGateOutput, DomainError>> => {
        const task = input.tasks.find((t) => t.id === taskId);
        // Only a still-runnable task can be gated; an already-settled task (done/blocked, e.g. a
        // relaunch re-entering it) is a no-op so re-runs stay idempotent.
        if (task === undefined || (task.status !== 'todo' && task.status !== 'in_progress')) {
          return Result.ok({});
        }
        if (task.dependsOn.length === 0) return Result.ok({});

        const unmet = task.dependsOn
          .map((depId) => ({ depId, dep: input.tasks.find((t) => t.id === depId) }))
          .filter(({ dep }) => dep === undefined || dep.status !== 'done');
        if (unmet.length === 0) return Result.ok({});

        const detail = unmet
          .map(({ depId, dep }) => (dep === undefined ? `${String(depId)} (missing)` : `${dep.name} (${dep.status})`))
          .join(', ');
        const reason = `blocked upstream — prerequisite not done: ${detail}`;

        const blocked = markTaskBlocked(task, reason);
        if (!blocked.ok) return Result.error(blocked.error);
        const persisted = await deps.taskRepo.update(input.sprintId, blocked.value);
        if (!persisted.ok) return Result.error(persisted.error);

        deps.logger.named('task.dependency-gate').warn(`task '${String(taskId)}' ${reason} — skipping (no AI spawn)`, {
          taskId: String(taskId),
          unmet: unmet.map(({ depId }) => String(depId)),
        });
        return Result.ok({ blocked: blocked.value });
      },
    },
    input: (ctx) => {
      if (ctx.tasks === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-dependency-gate',
          attemptedAction: `dependency-gate-${String(taskId)}`,
          message: `dependency-gate-${String(taskId)}: ctx.tasks is undefined — load-tasks must run first`,
        });
      }
      return { tasks: ctx.tasks, sprintId: ctx.sprintId };
    },
    output: (ctx, out) =>
      out.blocked === undefined
        ? ctx
        : {
            ...ctx,
            tasks: (ctx.tasks ?? []).map((t) => (t.id === out.blocked?.id ? out.blocked : t)),
          },
  });

/**
 * Predicate for the body guard that wraps a per-task subchain: the task is still runnable
 * (`todo`/`in_progress`) — i.e. the {@link dependencyGateLeaf} did NOT just block it. When the
 * gate blocked the task this returns `false`, so the guard synthesises a `skipped` trace entry
 * for the body instead of spawning the generator against an incomplete tree.
 *
 * @public
 */
export const isTaskRunnable = (ctx: ImplementCtx, taskId: TaskId): boolean => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  return task !== undefined && (task.status === 'todo' || task.status === 'in_progress');
};
