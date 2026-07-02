import { type LearningRecord, isDecision, isLearning } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { TaskKind } from '@src/business/task/derive-task-kind.ts';

/**
 * Compose the read-only "from prior sprints on this project" block injected into the FULL implement
 * prompt (principle 3, read side). The records are this project's not-yet-promoted, not-retired
 * ledger rows loaded once by `loadLearningsLeaf` in the implement prologue — BOTH `learning` and
 * `decision` rows share the ledger. This helper partitions them by kind and turns the most relevant
 * slice of each into a compact, deterministic markdown body so a sprint N+1 generator does not
 * re-discover what sprint N already earned OR decided.
 *
 * Decisions ride under a clear `Decisions from prior sprints:` sub-heading WITHIN the same block —
 * no new prompt placeholder.
 *
 * Selection is relevance-weighted against the current task's {@link PriorLearningsContext} (repo +
 * taskKind), then recency-filled to the per-kind cap: records for the SAME repo rank first, then
 * records of the same taskKind (different repo), then everything else — with recency (ledger append
 * order, newest first) breaking ties and filling the remainder of the cap. Rendering groups by that
 * same relevance tier (most-relevant block first), append order within a tier. When no context is
 * supplied (or it carries neither repo nor taskKind) the selection degrades cleanly to recency-only
 * — the most recent N by append order — so a caller that cannot resolve the current task's repo/kind
 * still gets a well-formed, bounded block.
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

/** Max rows rendered PER KIND — the most relevant N (repo/taskKind-weighted, recency-filled). */
export const PRIOR_LEARNINGS_MAX = 15;

/**
 * The current task's identity, used to relevance-weight which prior-sprint records surface. Both
 * fields are optional: a caller that can resolve neither gets recency-only selection (the pre-
 * relevance-weighting behaviour).
 *
 * @public
 */
export interface PriorLearningsContext {
  /** Absolute path of the repo the current task runs in — records with a matching `repo` rank first. */
  readonly repo?: string | undefined;
  /** Coarse kind of the current task — records with a matching `taskKind` (different repo) rank next. */
  readonly taskKind?: TaskKind | undefined;
}

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

/**
 * Relevance score for one record against the current task: repo match weighs more than taskKind
 * match, so any same-repo record outranks any non-repo record and, among the rest, a same-taskKind
 * record outranks an unrelated one. `0` when the context carries no repo/taskKind (or nothing
 * matches) — every record scores 0 and selection collapses to pure recency.
 */
const relevanceScore = (record: LearningRecord, context: PriorLearningsContext): number => {
  const repoMatch = context.repo !== undefined && record.repo === context.repo ? 2 : 0;
  const kindMatch = context.taskKind !== undefined && record.taskKind === context.taskKind ? 1 : 0;
  return repoMatch + kindMatch;
};

/**
 * Select up to {@link PRIOR_LEARNINGS_MAX} records for one kind, ranked by relevance then recency,
 * and return them in render order (relevance tier first, append order within a tier). Records arrive
 * in ledger append order, so a higher index is newer.
 */
const selectForKind = (
  records: readonly LearningRecord[],
  context: PriorLearningsContext
): readonly LearningRecord[] => {
  const scored = records.map((record, index) => ({ record, index, score: relevanceScore(record, context) }));
  // Selection priority: higher relevance first; within equal relevance, newer first — so when a tier
  // overflows the cap the most recent members of that tier are the ones kept.
  const kept = [...scored].sort((a, b) => b.score - a.score || b.index - a.index).slice(0, PRIOR_LEARNINGS_MAX);
  // Render order: same relevance grouping (most relevant block first), append order within a tier —
  // matching the recency-only path's oldest→newest reading order and staying deterministic.
  return kept.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.record);
};

/** Render a selected record set as bullet lines, dropping empties (cap already applied upstream). */
const renderLines = (records: readonly LearningRecord[]): readonly string[] =>
  records.map(learningLine).filter((l) => l.length > 0);

export const composePriorLearnings = (
  records: readonly LearningRecord[],
  context: PriorLearningsContext = {}
): string => {
  // Partition by kind, then relevance-weight + cap EACH independently (repo/taskKind first, recency-fill).
  const learningLines = renderLines(selectForKind(records.filter(isLearning), context));
  const decisionLines = renderLines(selectForKind(records.filter(isDecision), context));

  const blocks: string[] = [];
  if (learningLines.length > 0) blocks.push(learningLines.join('\n'));
  // Decisions ride under a sub-heading inside the same block so the generator can tell an earned
  // observation from a deliberate architectural choice without a separate prompt placeholder.
  if (decisionLines.length > 0) blocks.push(['Decisions from prior sprints:', ...decisionLines].join('\n'));
  return blocks.join('\n\n');
};
