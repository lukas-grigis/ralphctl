import type { PlanCheckFinding } from '@src/business/sprint/check-plan.ts';
import type { TodoTask } from '@src/domain/entity/task.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { Result } from '@src/domain/result.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';

const LEAF_NAME = 'review-ideate';
const PRE_STATE = 'pre-review-ideate';

export interface ReviewIdeateLeafDeps {
  /**
   * Optional human-in-the-loop gate wired by the launcher. Receives the approved requirements
   * body, the proposed tasks and the critic's findings. When omitted (tests, headless) the result
   * is auto-accepted — findings are advisory and never auto-reject.
   */
  readonly reviewBeforeApprove?: (
    requirements: string,
    proposedTasks: readonly TodoTask[],
    checkFindings: readonly PlanCheckFinding[]
  ) => Promise<{ readonly accept: boolean }>;
}

interface ReviewIdeateInput {
  readonly requirements: string;
  readonly proposedTasks: readonly TodoTask[];
  readonly checkFindings: readonly PlanCheckFinding[];
}

/**
 * The harness review gate between the in-session ideate approval and persistence, mirroring
 * `apply-plan`. On reject (or a cancelled prompt — the launcher maps cancel to reject) the ctx
 * sprint + tasks are restored to their pre-ideate values and `ideateRejected` is stamped, so
 * `transition-to-planned` skips and the downstream saves rewrite the unchanged sprint.
 */
export const reviewIdeateLeaf = (deps: ReviewIdeateLeafDeps): Element<IdeateCtx> =>
  leaf<IdeateCtx, ReviewIdeateInput, { readonly accept: boolean }>(LEAF_NAME, {
    useCase: {
      execute: async (input) => {
        if (deps.reviewBeforeApprove === undefined) return Result.ok({ accept: true });
        return Result.ok(await deps.reviewBeforeApprove(input.requirements, input.proposedTasks, input.checkFindings));
      },
    },
    input: (ctx) => ({
      requirements: assertCtxField(ctx, 'addedTicket', LEAF_NAME, PRE_STATE).requirements,
      proposedTasks: assertCtxField(ctx, 'proposedTasks', LEAF_NAME, PRE_STATE),
      checkFindings: ctx.planCheck?.findings ?? [],
    }),
    output: (ctx, out) => {
      if (out.accept) return ctx;
      const pre = assertCtxField(ctx, 'preIdeate', LEAF_NAME, PRE_STATE);
      return { ...ctx, sprint: pre.sprint, tasks: pre.tasks, ideateRejected: true };
    },
  });
