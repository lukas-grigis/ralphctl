import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { ensureFeedbackFileLeaf } from '@src/application/flows/review/leaves/ensure-feedback-file.ts';
import { reviewRoundLeaf } from '@src/application/flows/review/leaves/review-round.ts';
import { transitionSprintToDoneLeaf } from '@src/application/flows/_shared/sprint/transition-to-done.ts';

const DEFAULT_MAX_ROUNDS = 50;

export interface CreateReviewFlowOpts {
  readonly sprintId: SprintId;
  readonly cwd: AbsolutePath;
  readonly feedbackFile: AbsolutePath;
  readonly progressFile?: AbsolutePath;
  readonly verifyScript?: string;
  /** Safety cap on rounds; production runs hit this only on a UI bug. Default 50. */
  readonly maxRounds?: number;
}

/**
 * Build the review chain.
 *
 *   sequential('review', [
 *     load-and-assert-sprint(['review']),
 *     ensure-feedback-file,
 *     loop('review-loop', review-round, { shouldStop: ctx.lastReviewExit !== undefined }),
 *     transition-sprint-to-done,
 *   ])
 *
 * The review chain assumes the implement chain has already run (sprint is in `review`). The
 * `loadAndAssertSprintSubChain` whitelist enforces that — running review on a `planned`
 * sprint fails fast.
 */
export const createReviewFlow = (deps: ReviewDeps, opts: CreateReviewFlowOpts): Element<ReviewCtx> => {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const reviewRound = reviewRoundLeaf(
    {
      interactive: deps.interactive,
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      signals: deps.signals,
      eventBus: deps.eventBus,
      logger: deps.logger,
      gitRunner: deps.gitRunner,
      shellScriptRunner: deps.shellScriptRunner,
      appendFile: deps.appendFile,
      runsRoot: deps.runsRoot,
      model: deps.model,
    },
    {
      cwd: opts.cwd,
      ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
    }
  );

  return sequential<ReviewCtx>('review', [
    loadAndAssertSprintSubChain<ReviewCtx>({ sprintRepo: deps.sprintRepo }, ['review']),
    ensureFeedbackFileLeaf(opts.feedbackFile),
    loop<ReviewCtx>('review-loop', reviewRound, {
      shouldContinue: (_ctx, i) => i <= maxRounds,
      shouldStop: (ctx) => ctx.lastReviewExit !== undefined,
    }),
    transitionSprintToDoneLeaf({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
  ]);
};
