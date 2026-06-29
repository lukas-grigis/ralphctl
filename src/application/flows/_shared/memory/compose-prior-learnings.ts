import { type LearningRecord, isDecision, isLearning } from '@src/application/flows/_shared/memory/learning-record.ts';

/**
 * Compose the read-only "from prior sprints on this project" block injected into the FULL implement
 * prompt (principle 3, read side). The records are this project's not-yet-promoted, not-retired
 * ledger rows loaded once by `loadLearningsLeaf` in the implement prologue — BOTH `learning` and
 * `decision` rows share the ledger. This helper partitions them by kind and turns the most recent
 * slice of each into a compact, deterministic markdown body so a sprint N+1 generator does not
 * re-discover what sprint N already earned OR decided.
 *
 * Decisions ride under a clear `Decisions from prior sprints:` sub-heading WITHIN the same block —
 * no new prompt placeholder. Recency-selected only (the most recent N by append order per kind); per
 * the deferred-ranking decision there is NO taskKind/repo relevance weighting.
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

/** Max rows rendered PER KIND — the most recent N by ledger append order (records arrive append-order). */
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

/** Render the most-recent-N slice of a record set as bullet lines, dropping empties. */
const renderLines = (records: readonly LearningRecord[]): readonly string[] =>
  records
    .slice(-PRIOR_LEARNINGS_MAX)
    .map(learningLine)
    .filter((l) => l.length > 0);

export const composePriorLearnings = (records: readonly LearningRecord[]): string => {
  // Partition by kind, then keep the most recent N of EACH (tail = newest by ledger append order).
  const learningLines = renderLines(records.filter(isLearning));
  const decisionLines = renderLines(records.filter(isDecision));

  const blocks: string[] = [];
  if (learningLines.length > 0) blocks.push(learningLines.join('\n'));
  // Decisions ride under a sub-heading inside the same block so the generator can tell an earned
  // observation from a deliberate architectural choice without a separate prompt placeholder.
  if (decisionLines.length > 0) blocks.push(['Decisions from prior sprints:', ...decisionLines].join('\n'));
  return blocks.join('\n\n');
};
