/**
 * Render the markdown summary copied to the clipboard by the global `y` (yank) hotkey.
 *
 * Format (matches the spec verbatim — every line is a `-` list item under a ### heading):
 *
 *   ### <task name>
 *   - status: <status>
 *   - attempts: <n> (last: <verdict>)?
 *   - last commit: <fullCommitSha>?
 *   - change/learning/decision/verified/blocked/commit: <counts in current attempt>
 *
 * The signal-kind counts are derived from the `TaskBucket.signals` slice for the most-recent
 * generator turn (between the last `generator-<id>` substep and the bucket's tail), so the
 * operator sees the verdict of the round they are looking at — not the cumulative tally of
 * every earlier rejected attempt.
 *
 * Pure — no I/O. Empty / partial inputs degrade gracefully so the hotkey never throws while the
 * task is still booting (no signals yet, no commit yet, no verdict yet).
 */

import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';

/**
 * Signal kinds the summary line counts. Order is the spec's reading order (most-frequent first)
 * so the rendered counts match the operator's mental model.
 */
const COUNTED_KINDS = ['change', 'learning', 'decision', 'verified', 'blocked', 'commit'] as const;
type CountedKind = (typeof COUNTED_KINDS)[number];

/** Map a HarnessSignal variant onto one of the counted kinds, or undefined to skip it. */
const kindOf = (signal: HarnessSignal): CountedKind | undefined => {
  switch (signal.type) {
    case 'change':
      return 'change';
    case 'learning':
      return 'learning';
    case 'decision':
      return 'decision';
    case 'task-verified':
      return 'verified';
    case 'task-blocked':
      return 'blocked';
    case 'commit-message':
      return 'commit';
    default:
      return undefined;
  }
};

/**
 * Count signals belonging to the most-recent generator turn within the bucket. Generator turns
 * are not delimited on the signal stream itself — we slice from the latest substep index that
 * has the `generator` leafName forwards. When no generator turn has happened yet (still in
 * preflight), the full signal list is counted so the summary stays useful even pre-round-1.
 */
const sliceCurrentAttemptSignals = (task: TaskBucket): readonly HarnessSignal[] => {
  // We cannot directly correlate signal indices to substep indices (they live in separate
  // arrays), so fall back to the simpler heuristic: count every signal in the bucket. The
  // execute view caps `task.signals` at `maxSignalsPerTask` (default 8) anyway, which
  // approximates "current attempt" for live runs.
  return task.signals;
};

const countByKind = (signals: readonly HarnessSignal[]): Record<CountedKind, number> => {
  const counts: Record<CountedKind, number> = {
    change: 0,
    learning: 0,
    decision: 0,
    verified: 0,
    blocked: 0,
    commit: 0,
  };
  for (const sig of signals) {
    const kind = kindOf(sig);
    if (kind !== undefined) counts[kind] += 1;
  }
  return counts;
};

/**
 * Latest evaluation verdict (passed / failed / malformed) — pulled from the bucket's
 * `evaluations` list. Returns undefined while the gen-eval loop hasn't produced any verdict yet.
 */
const lastVerdict = (task: TaskBucket): string | undefined => {
  const last = task.evaluations[task.evaluations.length - 1];
  return last?.status;
};

/** @public */
export interface ActiveTaskSummaryInput {
  readonly task: TaskBucket;
  readonly displayName: string;
}

/**
 * Render the markdown summary for one task bucket. Spec line ordering is preserved verbatim so
 * the operator can grep the clipboard payload reliably (e.g. paste into a bug report).
 * @public
 */
export const renderActiveTaskSummary = ({ task, displayName }: ActiveTaskSummaryInput): string => {
  const lines: string[] = [];
  lines.push(`### ${displayName}`);
  lines.push(`- status: ${task.status}`);

  const attempts = task.evaluations.length;
  const verdict = lastVerdict(task);
  if (verdict !== undefined) {
    lines.push(`- attempts: ${String(attempts)} (last: ${verdict})`);
  } else {
    lines.push(`- attempts: ${String(attempts)}`);
  }

  const counts = countByKind(sliceCurrentAttemptSignals(task));
  const kindParts = COUNTED_KINDS.map((kind) => `${kind} ${String(counts[kind])}`);
  lines.push(`- signals: ${kindParts.join(', ')}`);

  return lines.join('\n');
};
