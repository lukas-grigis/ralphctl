/**
 * Toast copy for the sprints list's bulk `u` (unblock every stuck task on the focused sprint).
 * Pulled out of `sprints-view.tsx`, which keeps the unblock loop that tallies the outcome — this
 * module only turns that tally into one line.
 */

import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';

export interface UnblockFeedbackInput {
  readonly succeeded: number;
  readonly total: number;
  readonly lastError: string | undefined;
  readonly sprintName: string;
  /** Named in the retry clause below — the sprint every task in this run belongs to. */
  readonly sprintId: Sprint['id'];
  /**
   * Unblocks that revived their task but left the sprint CLOSED, because another sprint of the
   * same project already holds it (`UnblockTaskOutput.sprintReopenConflict` — see
   * `business/task/unblock-task.ts`). Counted on its own because it is not a failure: those
   * unblocks are in `succeeded` too, and without this the toast would read as a clean recovery
   * while the revived work stays unreachable behind a `done` sprint.
   */
  readonly reopenRefused: number;
  /** The last refusal's message — it names the peer holding the project. */
  readonly reopenReason: string | undefined;
  /**
   * The last refusal's hint (`ConflictError.hint`) — names the command that releases the peer
   * (`ralphctl sprint close <id>`). Distinct from `reopenReason`: the message says WHY the reopen
   * was refused, the hint says what to run about it. Sprint-detail's `u` toast
   * (`detail-handlers.ts`'s `unblockedToast`) already surfaces both; this list's bulk `u` must
   * match it, not just the message.
   */
  readonly reopenHint: string | undefined;
  /**
   * The sprint reopen this run performed (`UnblockTaskOutput.sprintReopened`): where the sprint
   * started, and where the last unblock left it. Only the first unblock on a settled sprint
   * reopens it; later ones find it open already, so "first `from`, last status" is the whole hop.
   */
  readonly reopened: { readonly from: Sprint['status']; readonly to: Sprint['status'] } | undefined;
}

/**
 * Mirrors `detail-handlers.ts`'s `unblockedToast` retry clause — this list already has an `r`
 * reload chord (sprint-detail didn't, until the same fix added one there), so the follow-up
 * names it as the step that actually re-reads the sprint before `u` can finish the job.
 */
const retryClause = (sprintId: Sprint['id']): string =>
  `then 'ralphctl sprint reopen ${String(sprintId)}', then r to reload, then u again`;

/** The "sprint stayed closed" tail — reason, hint, and the retry steps, or '' when nothing refused. */
const stayedClosedClause = (
  sprintId: Sprint['id'],
  reopenRefused: number,
  reopenReason: string | undefined,
  reopenHint: string | undefined
): string => {
  if (reopenRefused === 0) return '';
  const reasonClause = reopenReason !== undefined ? `: ${reopenReason}` : '';
  const hintClause = reopenHint !== undefined ? ` ${glyphs.emDash} ${reopenHint}` : '';
  return ` ${glyphs.emDash} sprint stayed closed${reasonClause}${hintClause} ${glyphs.emDash} ${retryClause(sprintId)}`;
};

/**
 * The "sprint reopened X → Y" clause plus whether that hop stopped short of `active` — a settled
 * sprint coming back open is a state change the operator must see, and the caller's head glyph
 * needs to know when to downgrade from a plain success tick.
 */
const reopenedClause = (
  reopened: UnblockFeedbackInput['reopened']
): { readonly text: string; readonly notFullyActive: boolean } => {
  if (reopened === undefined) return { text: '', notFullyActive: false };
  const notFullyActive = reopened.to !== 'active';
  // `from === to` is a retried review → active hop that failed again: nothing moved.
  const text =
    reopened.from === reopened.to
      ? ` ${glyphs.emDash} sprint still ${reopened.to}`
      : ` ${glyphs.emDash} sprint reopened ${reopened.from} ${glyphs.arrowRight} ${reopened.to}${notFullyActive ? ', not active' : ''}`;
  return { text, notFullyActive };
};

/**
 * Pure `succeeded`/`total`/`lastError` → toast-message formatter for a bulk-unblock run.
 *
 * Every task in one run belongs to the SAME sprint, so N refusals describe one sprint that stayed
 * closed, not N of them: the count gates the clause, and the conflict's own message says which
 * sprint holds the project instead.
 */
export const formatUnblockFeedback = ({
  succeeded,
  total,
  lastError,
  sprintName,
  sprintId,
  reopenRefused,
  reopenReason,
  reopenHint,
  reopened,
}: UnblockFeedbackInput): string => {
  const { text: reopenedText, notFullyActive } = reopenedClause(reopened);
  const stayedClosed = stayedClosedClause(sprintId, reopenRefused, reopenReason, reopenHint);
  // A refused reopen or a stalled second hop means the run did NOT cleanly finish even when every
  // task's own transition succeeded — the head glyph must say so, or a `✓` in front of "sprint
  // stayed closed" / "not active" reads as "all done" when there is still something to do.
  const anyIssue = reopenRefused > 0 || notFullyActive;
  const headGlyph = succeeded === 0 ? glyphs.cross : anyIssue ? glyphs.warningGlyph : glyphs.check;
  const head =
    succeeded === total
      ? `${headGlyph} unblocked ${String(succeeded)} task${succeeded === 1 ? '' : 's'} in "${sprintName}"`
      : `${headGlyph} unblocked ${String(succeeded)} of ${String(total)}${lastError !== undefined ? ` ${glyphs.emDash} ${lastError}` : ''}`;
  return `${head}${reopenedText}${stayedClosed}`;
};
