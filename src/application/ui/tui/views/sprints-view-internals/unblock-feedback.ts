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
   * The sprint reopen this run performed (`UnblockTaskOutput.sprintReopened`): where the sprint
   * started, and where the last unblock left it. Only the first unblock on a settled sprint
   * reopens it; later ones find it open already, so "first `from`, last status" is the whole hop.
   */
  readonly reopened: { readonly from: Sprint['status']; readonly to: Sprint['status'] } | undefined;
}

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
  reopenRefused,
  reopenReason,
  reopened,
}: UnblockFeedbackInput): string => {
  const stayedClosed =
    reopenRefused > 0
      ? ` ${glyphs.emDash} sprint stayed closed${reopenReason !== undefined ? `: ${reopenReason}` : ''}`
      : '';
  // A settled sprint coming back open is a state change the operator must see. Stopped short of
  // `active` (a failed second hop), implement still can't run it — say so.
  const reopenedClause =
    reopened !== undefined
      ? ` ${glyphs.emDash} sprint reopened ${reopened.from} ${glyphs.arrowRight} ${reopened.to}${reopened.to === 'active' ? '' : ', not active'}`
      : '';
  const head =
    succeeded === total
      ? `${glyphs.check} unblocked ${String(succeeded)} task${succeeded === 1 ? '' : 's'} in "${sprintName}"`
      : `${succeeded > 0 ? glyphs.check : glyphs.cross} unblocked ${String(succeeded)} of ${String(total)}${lastError !== undefined ? ` ${glyphs.emDash} ${lastError}` : ''}`;
  return `${head}${reopenedClause}${stayedClosed}`;
};
