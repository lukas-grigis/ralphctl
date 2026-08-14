import type { Logger } from '@src/business/observability/logger.ts';
import type { PlanCheckFinding } from '@src/business/sprint/check-plan.ts';
import { planSprintUseCase, type PlanSprintOutput } from '@src/business/sprint/plan-sprint.ts';
import type { DraftSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';

/** Leaf name, reused as the `entity` / `attemptedAction` on the leaf's precondition errors. */
const LEAF_NAME = 'apply-plan';
const PRE_STATE = 'pre-apply-plan';

export interface ApplyPlanLeafDeps {
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
  /**
   * Optional human-in-the-loop approval callback wired by the flow factory. Receives the
   * proposal, the draft sprint, and the deterministic critic's findings so the rendered prompt
   * can surface them. When omitted (tests, CI, headless) the plan is auto-accepted — findings
   * included, since they are advisory and never auto-reject.
   */
  readonly reviewBeforeApprove?: (
    proposedTasks: readonly TodoTask[],
    sprint: DraftSprint,
    checkFindings: readonly PlanCheckFinding[]
  ) => Promise<{ readonly accept: boolean }>;
}

interface ApplyPlanInput {
  readonly sprint: DraftSprint;
  readonly existingTasks: readonly Task[];
  readonly proposedTasks: readonly TodoTask[];
  readonly checkFindings: readonly PlanCheckFinding[];
}

const isDraft = (s: Sprint): s is DraftSprint => s.status === 'draft';

/**
 * Owns the human gate and the `draft → planned` transition — the tail half of what
 * `call-planner-interactive` used to do in one leaf. Split out so the deterministic critic
 * (`check-plan`) runs BEFORE the approve/reject decision rather than after it; the split is also
 * the seam a later AI-critic rung slots into, between `check-plan` and here.
 *
 * Placed after `uninstall-skills` on purpose: the skills sandbox is torn down before a
 * potentially long human pause.
 */
export const applyPlanLeaf = (deps: ApplyPlanLeafDeps): Element<PlanCtx> =>
  leaf<PlanCtx, ApplyPlanInput, PlanSprintOutput>(LEAF_NAME, {
    useCase: {
      execute: async (input) =>
        planSprintUseCase({
          sprint: input.sprint,
          existingTasks: input.existingTasks,
          tasks: input.proposedTasks,
          checkFindings: input.checkFindings,
          clock: deps.clock,
          logger: deps.logger,
          ...(deps.reviewBeforeApprove !== undefined ? { reviewBeforeApprove: deps.reviewBeforeApprove } : {}),
        }),
    },
    input: (ctx) => {
      const sprint = assertCtxField(ctx, 'sprint', LEAF_NAME, PRE_STATE);
      if (!isDraft(sprint)) {
        throw new InvalidStateError({
          entity: 'sprint',
          currentState: sprint.status,
          attemptedAction: LEAF_NAME,
          message: `apply-plan: sprint must be draft — got '${sprint.status}'`,
        });
      }
      return {
        sprint,
        existingTasks: ctx.tasks ?? [],
        proposedTasks: assertCtxField(ctx, 'proposedTasks', LEAF_NAME, PRE_STATE),
        checkFindings: ctx.planCheck?.findings ?? [],
      };
    },
    output: (ctx, out) => {
      // On reject, leave ctx.sprint as the original DraftSprint (the use case returns the
      // input sprint unchanged) and don't stamp `plannedTasks` — downstream `save-tasks` and
      // `save-sprint` then write the unchanged sprint + existing task list (no-op).
      if (!out.accepted) return { ...ctx, sprint: out.sprint, tasks: out.tasks };
      return { ...ctx, sprint: out.sprint, tasks: out.tasks, plannedTasks: out.tasks as readonly TodoTask[] };
    },
  });
