import { type StartAttemptProps, startAttemptUseCase } from '@src/business/task/start-attempt.ts';
import { publishingBlockedWrites } from '@src/business/task/publish-task-blocked.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { resetAttemptScratch } from '@src/application/flows/implement/sprint-scoped-projection.ts';
import type { CrashResumeTarget } from '@src/business/task/crash-resume.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SessionId } from '@src/integration/ai/providers/_engine/session-id.ts';
import { readLastGeneratorRound } from '@src/application/flows/implement/leaves/round-artifacts.ts';

/**
 * Chain leaf — adapts ctx → startAttemptUseCase → ctx. Business policy (append a `running`
 * attempt, persist, audit log) lives in `@src/business/task/start-attempt.ts`. The
 * leaf adds chain-construction guards (task present in ctx) and projects the new in-progress
 * task back onto ctx alongside cleared per-task verdict state.
 */
export type StartAttemptLeafDeps = Omit<StartAttemptProps, 'task' | 'sprintId' | 'crashResume'> & {
  /**
   * Announces the one block this leaf can produce: resume recovery settling a leftover `running`
   * attempt pushes the task past its attempt budget, and the use case persists that block before
   * returning an error — so the chain never sees a blocked task to report. The use case's task
   * repo is wrapped in {@link publishingBlockedWrites} so that write publishes `TaskBlockedEvent`
   * the moment it is durable.
   */
  readonly eventBus: EventBus;
};

interface StartAttemptInput {
  readonly task: Task;
  readonly sprintId: SprintId;
  readonly workspaceRoot?: AbsolutePath;
}

/**
 * Crash-resume seed for the fresh attempt: when it opened as a resume of a harness-interrupted
 * attempt carrying that attempt's generator session, the first turn continues the thread with the
 * crash-resume prompt. Applied AFTER the per-attempt reset, which would otherwise clear it.
 */
const crashResumeSeed = (task: InProgressTask): Partial<ImplementCtx> => {
  const running = task.attempts.at(-1);
  if (running?.recovering?.cause !== 'harness-interrupted' || running.sessionId === undefined) return {};
  return { priorGeneratorSessionId: running.sessionId as SessionId, crashResumePending: true };
};

/**
 * `resumeTarget` names what this task's generator runs with now — provider, model and cwd — so an
 * interrupted attempt's session is only resumed when all three still match. Omitted → cold start.
 */
export const startAttemptLeaf = (
  deps: StartAttemptLeafDeps,
  taskId: TaskId,
  resumeTarget?: CrashResumeTarget
): Element<ImplementCtx> => {
  const { eventBus, ...useCaseDeps } = deps;
  const publishing = publishingBlockedWrites(deps.taskRepo, eventBus, deps.clock);
  const taskRepo: StartAttemptProps['taskRepo'] = {
    findById: (sprintId, id) => deps.taskRepo.findById(sprintId, id),
    update: (sprintId, task) => publishing.update(sprintId, task),
  };
  return leaf<ImplementCtx, StartAttemptInput, InProgressTask>(`start-attempt-${String(taskId)}`, {
    useCase: {
      execute: async ({ workspaceRoot, ...input }) =>
        startAttemptUseCase({
          ...useCaseDeps,
          taskRepo,
          ...input,
          ...(resumeTarget !== undefined && workspaceRoot !== undefined
            ? {
                crashResume: {
                  findLastGeneratorRound: () => readLastGeneratorRound(workspaceRoot),
                  target: resumeTarget,
                },
              }
            : {}),
        }),
    },
    input: (ctx) => {
      if (ctx.tasks === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-start-attempt',
          attemptedAction: `start-attempt-${String(taskId)}`,
          message: `start-attempt-${String(taskId)}: ctx.tasks is undefined — load-tasks must run first`,
        });
      }
      const task = ctx.tasks.find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-start-attempt',
          attemptedAction: `start-attempt-${String(taskId)}`,
          message: `start-attempt-${String(taskId)}: task '${String(taskId)}' not found in ctx.tasks`,
        });
      }
      return {
        task,
        sprintId: ctx.sprintId,
        ...(ctx.taskWorkspaceRoot !== undefined ? { workspaceRoot: ctx.taskWorkspaceRoot } : {}),
      };
    },
    // Start-attempt is the per-ATTEMPT boundary leaf. Under the outer attempt loop the same ctx
    // flows from one attempt into the next within a single launch, so the gen-eval turn counter,
    // plateau window, round pointer, latest evaluation, proposed commit message, generator /
    // evaluator session ids MUST reset here — otherwise
    // attempt 2's inner loop would inherit attempt 1's `plateauHistory` (plateau-on-first-eval), a
    // climbing `genEvalTurn`, a stale commit message, or a cross-attempt session resume that mixes
    // two unrelated bodies of work into one conversational thread. `resetAttemptScratch` is the
    // single, type-derived reset set for this boundary (see `sprint-scoped-projection.ts`) —
    // resetting realises the per-attempt semantics the ctx docs already describe ("a fresh
    // currentTask starts with an empty array"). `currentRoundNum` is recomputed by
    // `resolve-round-num` from max-on-disk so prior rounds are never overwritten even though the
    // in-memory pointer clears.
    output: (ctx, inProgress) => ({
      ...ctx,
      ...resetAttemptScratch(),
      ...crashResumeSeed(inProgress),
      currentTaskId: inProgress.id,
      currentTask: inProgress,
      tasks: (ctx.tasks ?? []).map((t) => (t.id === inProgress.id ? inProgress : t)),
    }),
    label: 'Start attempt',
    internal: true,
  });
};
