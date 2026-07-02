import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element } from '@src/application/chain/element.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { withRepoLock } from '@src/application/flows/_shared/with-repo-lock.ts';
import { loadAndAssertSprintSubChain } from '@src/application/flows/_shared/sprint/load-and-assert-sprint.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { ensureFeedbackFileLeaf } from '@src/application/flows/review/leaves/ensure-feedback-file.ts';
import { reviewRoundLeaf } from '@src/application/flows/review/leaves/review-round.ts';
import { transitionSprintToDoneLeaf } from '@src/application/flows/_shared/sprint/transition-to-done.ts';
import { createDistillStep } from '@src/application/flows/_shared/memory/distill-step.ts';

const DEFAULT_MAX_ROUNDS = 50;

export interface CreateReviewFlowOpts {
  readonly sprintId: SprintId;
  /**
   * Per-sprint directory — the cross-process lock key (`<dataRoot>/sprints/<id>/`). Review commits
   * to the sprint branch and runs verify, so it holds the SAME `withRepoLock` key the implement
   * flow uses, making an implement run and a review run of one sprint mutually exclude.
   */
  readonly sprintDir: AbsolutePath;
  /**
   * Parent dir for per-round AI session forensics — `<sprintDir>/review/`. The per-round
   * leaf materialises `round-<N>/` subfolders here. The AI session's cwd is the per-round
   * dir; every sprint-affected repo is mounted via `additionalRoots`. Mirrors plan's
   * symmetric multi-repo pattern; replaces the single `cwd` field whose pre-fix behaviour
   * blinded the AI to non-first repos on multi-repo sprints.
   */
  readonly reviewRoot: AbsolutePath;
  /**
   * Single repo working tree the harness commits / runs verify in. Distinct from the AI
   * session's cwd. The launcher picks the first sprint-affected repo — review still works
   * against the sprint branch in one repo today (multi-repo commit / verify is a separate
   * concern).
   */
  readonly commitCwd: AbsolutePath;
  /** Every sprint-affected repository (absolute path) — mounted as AI `additionalRoots`. */
  readonly additionalRoots: readonly AbsolutePath[];
  /** Pre-rendered `{{REPOSITORIES}}` Markdown block for the apply-feedback prompt. */
  readonly repositoriesBlock: string;
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
 *     guard('review-settled', ctx.lastReviewExit !== undefined, sequential('review-settle', [
 *       distill-learnings-step,                // opt-in; runs on the auto-done path
 *       transition-sprint-to-done,
 *     ])),
 *   ])
 *
 * The review chain assumes the implement chain has already run (sprint is in `review`). The
 * `loadAndAssertSprintSubChain` whitelist enforces that — running review on a `planned`
 * sprint fails fast.
 *
 * The distill step sits BEFORE the transition so it runs while the sprint is still `review`
 * (re-runnable on a mid-distill abort) and on the SAME auto-done path the empty-round termination
 * takes. When the user opted out (`distillRequested === false`) the inner `distill-gate` guard
 * skips the body; when `deps.distill` is absent the step is omitted entirely.
 *
 * Both settle steps are wrapped in a `review-settled` guard on `ctx.lastReviewExit !== undefined`.
 * The loop can also exit via its `shouldContinue` round cap (`i <= maxRounds`) — a fail-safe for a
 * UI bug that would otherwise re-enter the round forever. On THAT exit `lastReviewExit` is still
 * undefined (no human terminal decision was reached), so the guard skips both settle steps and the
 * sprint stays in `review` with a visible `skipped` trace entry. The cap exit also publishes a warn
 * banner from inside `shouldContinue` (off-trace, so the happy path stays clean) explaining WHY the
 * sprint stayed in `review`. The human end-of-sprint decision stays the only path to `done`, and
 * re-running review resumes cleanly because the status never moved.
 */
export const createReviewFlow = (deps: ReviewDeps, opts: CreateReviewFlowOpts): Element<ReviewCtx> => {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const reviewRound = reviewRoundLeaf(
    {
      interactive: deps.interactive,
      provider: deps.provider,
      templateLoader: deps.templateLoader,
      publishSignal: createPublishSignal(deps.eventBus, 'review-round'),
      eventBus: deps.eventBus,
      logger: deps.logger,
      clock: deps.clock,
      gitRunner: deps.gitRunner,
      shellScriptRunner: deps.shellScriptRunner,
      appendFile: deps.appendFile,
      model: deps.model,
    },
    {
      reviewRoot: opts.reviewRoot,
      commitCwd: opts.commitCwd,
      additionalRoots: opts.additionalRoots,
      repositoriesBlock: opts.repositoriesBlock,
      ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
    }
  );

  const chain = sequential<ReviewCtx>('review', [
    loadAndAssertSprintSubChain<ReviewCtx>({ sprintRepo: deps.sprintRepo }, ['review']),
    ensureFeedbackFileLeaf(opts.feedbackFile),
    loop<ReviewCtx>('review-loop', reviewRound, {
      // Pre-iteration round cap. `i > maxRounds` exits the loop without running another round.
      // When the cap is the reason we stop — no human terminal decision reached, `lastReviewExit`
      // still undefined — publish a warn banner from HERE so the operator knows WHY the sprint
      // stayed in 'review'. Emitting from `shouldContinue` keeps the banner OFF the trace: a
      // normal terminal exit makes `shouldStop` fire first, so this branch is never reached on
      // the happy path and the trace stays clean. Re-running review resumes cleanly (status never
      // moved).
      shouldContinue: (ctx, i) => {
        if (i <= maxRounds) return true;
        if (ctx.lastReviewExit === undefined) {
          deps.eventBus.publish({
            type: 'banner-show',
            id: 'review-cap-exhausted',
            tier: 'warn',
            message: `Review round cap (${maxRounds}) reached — sprint remains in 'review'. Re-run the review flow to continue.`,
            at: IsoTimestamp.now(),
          });
        }
        return false;
      },
      shouldStop: (ctx) => ctx.lastReviewExit !== undefined,
    }),
    // Only settle the sprint to `done` when the review loop reached a human terminal decision
    // (`lastReviewExit` set). A round-cap exit leaves it undefined → guard skips both settle steps
    // (a visible `skipped` trace entry) so a UI-bug-driven cap exhaustion never silently closes the
    // sprint. The human end-of-sprint decision stays the only path to `done`.
    guard<ReviewCtx>(
      'review-settled',
      (ctx) => ctx.lastReviewExit !== undefined,
      sequential<ReviewCtx>('review-settle', [
        ...(deps.distill !== undefined ? [createDistillStep<ReviewCtx>(deps.distill.deps, deps.distill.opts)] : []),
        transitionSprintToDoneLeaf<ReviewCtx>({ sprintRepo: deps.sprintRepo, clock: deps.clock, logger: deps.logger }),
      ])
    ),
  ]);

  // Hold the cross-process repo lock for the whole review run — keyed on the sprint dir, the SAME
  // key the implement flow uses, so a review and an implement of one sprint mutually exclude
  // (review commits to the sprint branch). Mirrors the serial implement path's wrapping.
  return withRepoLock<ReviewCtx>(
    {
      fileLocker: deps.fileLocker,
      locksRoot: deps.locksRoot,
      worktreePath: opts.sprintDir,
      eventBus: deps.eventBus,
    },
    chain
  );
};
