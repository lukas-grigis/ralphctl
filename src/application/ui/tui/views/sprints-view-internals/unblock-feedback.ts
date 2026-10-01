/** Toast copy for the sprints list's bulk `u` (unblock every stuck task on the focused sprint). */

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
   * Unblocks that revived their task but left the sprint CLOSED because another sprint of the same project already
   * holds it (`UnblockTaskOutput.sprintReopenConflict`). Counted apart so the toast doesn't read as a clean recovery.
   */
  readonly reopenRefused: number;
  /** The last refusal's message — it names the peer holding the project. */
  readonly reopenReason: string | undefined;
  /**
   * The last refusal's hint (`ConflictError.hint`) — names the command that releases the peer (`ralphctl sprint close
   * <id>`).
   */
  readonly reopenHint: string | undefined;
  /**
   * The sprint reopen this run performed (`UnblockTaskOutput.sprintReopened`): where the sprint started, and where
   * the last unblock left it.
   */
  readonly reopened: { readonly from: Sprint['status']; readonly to: Sprint['status'] } | undefined;
}

/**
 * Mirrors `detail-handlers.ts`'s `unblockedToast` retry clause — this list already has an `r` reload chord
 * (sprint-detail didn't, until the same fix added one there).
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
 * The "sprint reopened X → Y" clause plus whether that hop stopped short of `active` — a settled sprint coming back
 * open is a state change the operator must see.
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

/** Pure `succeeded`/`total`/`lastError` → toast-message formatter for a bulk-unblock run. */
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
  // A refused reopen or a stalled second hop means the run did NOT cleanly finish even when every task's own
  // transition succeeded — the head glyph must say so.
  const anyIssue = reopenRefused > 0 || notFullyActive;
  const headGlyph = succeeded === 0 ? glyphs.cross : anyIssue ? glyphs.warningGlyph : glyphs.check;
  const head =
    succeeded === total
      ? `${headGlyph} unblocked ${String(succeeded)} task${succeeded === 1 ? '' : 's'} in "${sprintName}"`
      : `${headGlyph} unblocked ${String(succeeded)} of ${String(total)}${lastError !== undefined ? ` ${glyphs.emDash} ${lastError}` : ''}`;
  return `${head}${reopenedText}${stayedClosed}`;
};
