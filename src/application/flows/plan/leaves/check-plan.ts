import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  checkPlanUseCase,
  type PlanCheckReport,
  renderPlanCheckFinding,
  severityOfFinding,
} from '@src/business/sprint/check-plan.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';

/** Leaf name, reused as the `attemptedAction` on the leaf's precondition errors. */
const LEAF_NAME = 'check-plan';
const PRE_STATE = 'pre-check-plan';

export interface CheckPlanLeafDeps {
  /**
   * Findings are published as `warn` records on the `plan.check` scope. The EventBus logger fans
   * them onto the bus, so they show live in the TUI and land in `<sprintDir>/chain.log` with no
   * extra plumbing — which is why the leaf needs no `writeFile` and stays zero-I/O.
   */
  readonly logger: Logger;
}

interface CheckPlanInput {
  readonly project: Project;
  readonly tasks: readonly TodoTask[];
}

/**
 * Zero-token deterministic plan critic. Runs between `call-planner-interactive` (which produces
 * `ctx.proposedTasks`) and `apply-plan` (which puts the proposal to the human), so the operator
 * approves or rejects with the critic's evidence already on screen.
 *
 * **Never fails the chain.** `checkPlanUseCase` is an infallible fold, and even `error`-tier
 * findings are advisory — a headless run with no reviewer wired logs them and proceeds. Making
 * the leaf fail would turn an advisory quality signal into a hard gate the operator cannot
 * override, which is the opposite of the human-stays-approver design.
 */
export const checkPlanLeaf = (deps: CheckPlanLeafDeps): Element<PlanCtx> =>
  leaf<PlanCtx, CheckPlanInput, PlanCheckReport>(LEAF_NAME, {
    useCase: {
      execute: async (input) => {
        const report = checkPlanUseCase(input);
        if (!report.ok) return Result.error(report.error);

        const log = deps.logger.named('plan.check');
        for (const finding of report.value.findings) {
          log.warn(renderPlanCheckFinding(finding), {
            kind: finding.kind,
            severity: severityOfFinding(finding),
          });
        }
        if (report.value.findings.length === 0) {
          log.debug('plan check found nothing', { taskCount: input.tasks.length });
        }
        return Result.ok(report.value);
      },
    },
    input: (ctx) => ({
      project: assertCtxField(ctx, 'project', LEAF_NAME, PRE_STATE),
      tasks: assertCtxField(ctx, 'proposedTasks', LEAF_NAME, PRE_STATE),
    }),
    output: (ctx, out) => ({ ...ctx, planCheck: out }),
  });
