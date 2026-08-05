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
 * Selection is relevance-weighted against the current task's {@link PriorLearningsContext}: repo and
 * taskKind match as before, plus (when the caller supplies `taskText`) an `appliesTo`/text token
 * overlap against the current task's own title/description/acceptance criteria — then recency-filled
 * to the per-kind cap. Rendering groups by relevance tier (most-relevant block first), append order
 * within a tier. When no context is supplied (or it carries neither repo, taskKind, nor taskText) the
 * selection degrades cleanly to recency-only — the most recent N by append order — so a caller that
 * cannot resolve the current task's identity still gets a well-formed, bounded block.
 *
 * ABSTAIN GATE: when `taskText` is supplied, a record with no topical signal at all (no taskKind
 * match, no appliesTo/text overlap) is dropped even if it matches on repo alone — on a long-lived
 * per-project ledger, repo match is near-universal and carries no relevance signal by itself.
 * Irrelevant injected experience measurably hurts a generator, more than injecting nothing (arXiv
 * 2602.08316) — so when the gate leaves nothing standing for a kind, that kind's block is simply
 * omitted, never padded with recency filler to look non-empty. Callers that do not supply `taskText`
 * (plan / ideate) never trip the gate — their output is byte-for-byte the pre-gate behaviour.
 *
 * Deliberately minimal per the implement template's own arXiv 2602.11988 citation (redundant always-loaded
 * context measurably raises cost without improving success): only the Insight (`text`) and the optional
 * Applies-to ride —
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
 * The current task's identity, used to relevance-weight which prior-sprint records surface. All
 * fields are optional: a caller that can resolve none of them gets recency-only selection (the
 * pre-relevance-weighting behaviour), and a caller that omits `taskText` never trips the abstain
 * gate (see module doc) — the plan/ideate callers rely on exactly that.
 *
 * @public
 */
export interface PriorLearningsContext {
  /** Absolute path of the repo the current task runs in — records with a matching `repo` rank first. */
  readonly repo?: string | undefined;
  /** Coarse kind of the current task — records with a matching `taskKind` (different repo) rank next. */
  readonly taskKind?: TaskKind | undefined;
  /**
   * Concatenated free text describing the current task (title + description + acceptance criteria),
   * supplied by the caller. Drives BOTH the `appliesTo`/text token-overlap scoring and the abstain
   * gate (see module doc). Absent (the default) leaves scoring and gating exactly as before this
   * field existed — the plan/ideate callers pass no `taskText` and are unaffected.
   */
  readonly taskText?: string | undefined;
  /**
   * Current time (ISO-8601), enabling a small age-decay penalty on old records (see {@link ageDecay}).
   * Absent (the default) applies zero decay — pure relevance + recency ordering, unchanged from
   * before this field existed.
   */
  readonly nowIso?: string | undefined;
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

/** Relevance weight for a `repo` match — outranks every other signal (see {@link scoreRecord}). */
const REPO_MATCH_WEIGHT = 2;
/** Relevance weight for a `taskKind` match. */
const TASK_KIND_MATCH_WEIGHT = 1;
/**
 * Relevance weight for a non-empty `appliesTo` token overlap against `taskText`. Flat (not scaled by
 * overlap ratio) — `appliesTo` is a short, curated tag, so any overlap at all is a strong "this record
 * names the area the current task touches" signal, on par with a repo match.
 */
const APPLIES_TO_OVERLAP_WEIGHT = 2;

/** Ignore tokens shorter than this — connective words that carry no topical signal on their own. */
const MIN_TOKEN_CHARS = 3;

/** Lower-case, punctuation-stripped token set for overlap scoring. Unicode-aware (`\p{L}`/`\p{N}`). */
const tokenize = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= MIN_TOKEN_CHARS)
  );

/** Jaccard similarity of two token sets — 0 when either is empty, 1 when they're identical. */
const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/** Age band past which a record starts losing rank — engineering budget, not a derived constant. */
const AGE_DECAY_STALE_DAYS = 90;
/** Age band past which the penalty doubles — engineering budget. */
const AGE_DECAY_OLD_DAYS = 180;
/** Penalty applied once a record crosses {@link AGE_DECAY_STALE_DAYS}. */
const AGE_DECAY_STALE_PENALTY = 0.5;
/** Penalty applied once a record crosses {@link AGE_DECAY_OLD_DAYS} (replaces, doesn't stack with, the stale penalty). */
const AGE_DECAY_OLD_PENALTY = 1;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Small recency penalty for an old record, subtracted from its relevance score. `0` whenever `nowIso`
 * is absent (the default — no behaviour change for a caller that never passes it) or either timestamp
 * fails to parse. Deliberately smaller than every relevance weight above (max penalty 1 < repo's 2 and
 * appliesTo's 2) so decay only orders WITHIN a relevance tier — it can break a tie between two
 * same-tier records but can never make a genuinely relevant record lose to an irrelevant one.
 */
const ageDecay = (record: LearningRecord, nowIso: string | undefined): number => {
  if (nowIso === undefined) return 0;
  const now = Date.parse(nowIso);
  const then = Date.parse(record.timestamp);
  if (Number.isNaN(now) || Number.isNaN(then)) return 0;
  const ageDays = (now - then) / ONE_DAY_MS;
  if (ageDays > AGE_DECAY_OLD_DAYS) return AGE_DECAY_OLD_PENALTY;
  if (ageDays > AGE_DECAY_STALE_DAYS) return AGE_DECAY_STALE_PENALTY;
  return 0;
};

interface ScoredRecord {
  readonly score: number;
  /** False when the abstain gate drops this record — see module doc. Always true when no `taskText`. */
  readonly qualifies: boolean;
}

/**
 * Relevance score for one record against the current task, plus the abstain-gate verdict. Repo match
 * (2) outranks appliesTo overlap (2, tied — both are strong, curated signals) which outranks taskKind
 * match (1); text overlap contributes a weak `0..1` additive signal on top. `taskTextTokens` is
 * `undefined` whenever the caller supplied no `taskText`, which both zeroes the overlap terms AND
 * forces `qualifies` to `true` unconditionally (the pre-gate behaviour).
 */
const scoreRecord = (
  record: LearningRecord,
  context: PriorLearningsContext,
  taskTextTokens: ReadonlySet<string> | undefined
): ScoredRecord => {
  const repoMatch = context.repo !== undefined && record.repo === context.repo;
  const kindMatch = context.taskKind !== undefined && record.taskKind === context.taskKind;

  const hasAppliesToOverlap =
    taskTextTokens !== undefined &&
    record.appliesTo !== undefined &&
    record.appliesTo.trim().length > 0 &&
    jaccard(tokenize(record.appliesTo), taskTextTokens) > 0;

  const textOverlap = taskTextTokens !== undefined ? jaccard(tokenize(record.text), taskTextTokens) : 0;

  const relevance =
    (repoMatch ? REPO_MATCH_WEIGHT : 0) +
    (kindMatch ? TASK_KIND_MATCH_WEIGHT : 0) +
    (hasAppliesToOverlap ? APPLIES_TO_OVERLAP_WEIGHT : 0) +
    textOverlap;

  return {
    score: relevance - ageDecay(record, context.nowIso),
    // Abstain gate (arXiv 2602.08316): once taskText is supplied, bare repo match is not a relevance
    // signal by itself — require a taskKind match or measured topical overlap instead.
    qualifies: taskTextTokens === undefined || kindMatch || hasAppliesToOverlap || textOverlap > 0,
  };
};

/**
 * Select up to {@link PRIOR_LEARNINGS_MAX} qualifying records for one kind, ranked by score then
 * recency, and return them in render order (highest score first, append order within a tie). Records
 * arrive in ledger append order, so a higher index is newer.
 */
const selectForKind = (
  records: readonly LearningRecord[],
  context: PriorLearningsContext,
  taskTextTokens: ReadonlySet<string> | undefined
): readonly LearningRecord[] => {
  const scored = records
    .map((record, index) => ({ record, index, ...scoreRecord(record, context, taskTextTokens) }))
    .filter((entry) => entry.qualifies);
  // Selection priority: higher score first; within a tie, newer first — so when a tier overflows the
  // cap the most recent members of that tier are the ones kept.
  const kept = [...scored].sort((a, b) => b.score - a.score || b.index - a.index).slice(0, PRIOR_LEARNINGS_MAX);
  // Render order: same score-descending grouping, append order within a tie — matching the
  // recency-only path's oldest→newest reading order and staying deterministic.
  return kept.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.record);
};

/** Render a selected record set as bullet lines, dropping empties (cap already applied upstream). */
const renderLines = (records: readonly LearningRecord[]): readonly string[] =>
  records.map(learningLine).filter((l) => l.length > 0);

export const composePriorLearnings = (
  records: readonly LearningRecord[],
  context: PriorLearningsContext = {}
): string => {
  // Tokenized once and shared by both kinds — taskText itself never differs by kind.
  const taskTextTokens = context.taskText !== undefined ? tokenize(context.taskText) : undefined;

  // Partition by kind, then relevance-weight + gate + cap EACH independently (repo/taskKind/overlap
  // first, recency-fill). A kind left with nothing after the gate contributes no block — the correct
  // abstain output, never padded with recency filler.
  const learningLines = renderLines(selectForKind(records.filter(isLearning), context, taskTextTokens));
  const decisionLines = renderLines(selectForKind(records.filter(isDecision), context, taskTextTokens));

  const blocks: string[] = [];
  if (learningLines.length > 0) blocks.push(learningLines.join('\n'));
  // Decisions ride under a sub-heading inside the same block so the generator can tell an earned
  // observation from a deliberate architectural choice without a separate prompt placeholder.
  if (decisionLines.length > 0) blocks.push(['Decisions from prior sprints:', ...decisionLines].join('\n'));
  return blocks.join('\n\n');
};
