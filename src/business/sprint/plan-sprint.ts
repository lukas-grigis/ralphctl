import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { planSprint, type DraftSprint, type PlannedSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Mediate the AI-produced plan output into a sprint transition, gated by an optional
 * `reviewBeforeApprove` hook so a human can veto the proposed task set before the sprint
 * transitions from `draft` to `planned`.
 *
 * Caller has already produced the parsed `TodoTask[]` (the planner's output); this use case
 * logs the outcome, runs the `draft → planned` domain transition, and bundles both for the
 * chain's downstream `save-tasks` + `save-sprint` leaves to persist atomically.
 *
 * Pure-ish: a single async point at the optional hook; otherwise no I/O. The clock is injected
 * so tests can pin the planning timestamp.
 *
 * Rejection modes:
 *  - `reviewBeforeApprove` returned `accept: false` → sprint stays `draft`, no task replacement,
 *    output's `accepted` flag is `false`. The chain leaf reads this flag and skips the
 *    persistence side-effects (no `plannedTasks` on ctx; downstream save leaves no-op).
 *  - `planSprint` validates that the sprint has at least one approved ticket and at least one
 *    affected repository on its execution. Both are pre-conditions met by the time refine +
 *    create-sprint have run; if they aren't, the transition fails and the chain halts before
 *    save.
 */
export interface PlanSprintProps {
  readonly sprint: DraftSprint;
  /** Existing tasks already on the sprint — surfaced to the reviewer alongside the proposal. */
  readonly existingTasks: readonly Task[];
  readonly tasks: readonly TodoTask[];
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /**
   * Human-in-the-loop approval callback. Called AFTER the AI's plan is parsed and BEFORE the
   * `draft → planned` transition. Resolve with `accept: true` to approve, `false` to reject.
   * When omitted the proposal is auto-accepted — appropriate for CI / headless runs.
   */
  readonly reviewBeforeApprove?: (
    proposedTasks: readonly TodoTask[],
    sprint: DraftSprint
  ) => Promise<{ readonly accept: boolean }>;
}

export interface PlanSprintOutput {
  /** `PlannedSprint` on accept, the input `DraftSprint` on reject. */
  readonly sprint: Sprint;
  /** Newly proposed tasks on accept; the existing task set on reject. */
  readonly tasks: readonly Task[];
  /** `true` when the proposal was approved; `false` when the reviewer rejected. */
  readonly accepted: boolean;
}

export const planSprintUseCase = async (
  props: PlanSprintProps
): Promise<Result<PlanSprintOutput, InvalidStateError>> => {
  const log = props.logger.named('sprint.plan');
  log.debug('planning sprint', { sprintId: props.sprint.id, taskCount: props.tasks.length });

  if (props.reviewBeforeApprove !== undefined) {
    const decision = await props.reviewBeforeApprove(props.tasks, props.sprint);
    if (!decision.accept) {
      log.info('reviewer rejected the proposed plan — leaving sprint draft', {
        sprintId: props.sprint.id,
        proposedTaskCount: props.tasks.length,
      });
      return Result.ok({ sprint: props.sprint, tasks: props.existingTasks, accepted: false });
    }
  }

  const transitioned = planSprint(props.sprint, props.clock());
  if (!transitioned.ok) {
    log.warn('invalid state transition', {
      sprintId: props.sprint.id,
      from: props.sprint.status,
      error: transitioned.error.message,
    });
    return Result.error(transitioned.error);
  }

  log.info(`planned sprint '${transitioned.value.slug}' with ${String(props.tasks.length)} task(s)`, {
    sprintId: transitioned.value.id,
    taskCount: props.tasks.length,
  });
  return Result.ok({
    sprint: transitioned.value as PlannedSprint,
    tasks: props.tasks,
    accepted: true,
  });
};
