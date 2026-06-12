import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';

/**
 * Compose the read-only "learnings from prior sprints on this project" block injected into the FULL
 * implement prompt (principle 3, read side). The records are this project's not-yet-promoted ledger
 * rows loaded once by `loadLearningsLeaf` in the implement prologue; this helper turns the most
 * recent slice into a compact, deterministic markdown body the generator can orient on so a sprint
 * N+1 generator does not re-discover what sprint N already earned.
 *
 * Deliberately minimal per the implement template's own arXiv 2602.11988 citation (redundant context
 * measurably reduces agent success): only the Insight (`text`) and the optional Applies-to ride —
 * never the full record (sprint/task ids, timestamps, repo paths are noise to the generator). A hard
 * cap keeps the block bounded on a project with a long memory.
 *
 * Returns '' when there are no records so the `{{PRIOR_LEARNINGS}}` placeholder collapses cleanly.
 *
 * Pure. No I/O. Deterministic for a given input (vital for prompt-regression test stability).
 *
 * @public
 */

/** Max learnings rendered — the most recent N by ledger append order (records arrive append-order). */
export const PRIOR_LEARNINGS_MAX = 15;

/** Per-line character clamp so one learning can never carry a paragraph into the prompt. */
const LINE_MAX_CHARS = 240;

const clamp = (raw: string): string => {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > LINE_MAX_CHARS ? `${oneLine.slice(0, LINE_MAX_CHARS - 1)}…` : oneLine;
};

const learningLine = (record: LearningRecord): string => {
  const insight = clamp(record.text);
  if (insight.length === 0) return '';
  const where =
    record.appliesTo !== undefined && record.appliesTo.trim().length > 0
      ? ` (applies to ${clamp(record.appliesTo)})`
      : '';
  return `- ${insight}${where}`;
};

export const composePriorLearnings = (records: readonly LearningRecord[]): string => {
  // Keep the most recent N (tail = newest by ledger append order), then render Insight + Applies-to.
  const lines = records
    .slice(-PRIOR_LEARNINGS_MAX)
    .map(learningLine)
    .filter((l) => l.length > 0);
  return lines.length === 0 ? '' : lines.join('\n');
};
