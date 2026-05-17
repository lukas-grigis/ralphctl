import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { FeedbackRound } from '@src/business/feedback/md-parser.ts';
import type { ReviewRoundExit } from '@src/business/feedback/run-review-round.ts';

/**
 * Context flowing through the review chain. The per-round leaf threads `previousRound` between
 * iterations so the next round's termination check can compare bodies, and writes
 * `lastReviewExit` when a terminal condition is reached so the surrounding `loop` exits.
 */
export interface ReviewCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  readonly feedbackFile?: AbsolutePath;
  readonly progressFile?: AbsolutePath;
  /** Set when the user aborts (editor non-zero exit, AI self-blocks) so transition-to-done skips. */
  readonly aborted?: boolean;
  /** Number of rounds processed (informational; surfaced in logs). */
  readonly roundsApplied?: number;
  /** Latest parsed round; threaded between loop iterations for the next termination check. */
  readonly previousRound?: FeedbackRound;
  /** Terminal exit set by the per-round leaf; the loop's `shouldStop` reads this. */
  readonly lastReviewExit?: ReviewRoundExit;
}
