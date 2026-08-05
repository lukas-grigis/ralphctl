import type { Attempt, AttemptWarning, Attribution, TerminalAttempt } from '@src/domain/entity/attempt.ts';

/**
 * Turn a task's persisted attempt history into bounded, structured prior-attempt summaries for
 * the next retry's prompt context.
 *
 * Research grounding:
 *  - arXiv 2604.16529 (Meta, Parallel-Distill-Refine) — retries conditioned on the K BEST prior
 *    summaries beat latest-only and random-K, and refinement-context quality is monotonically
 *    predictive of next-iteration success. `selectKBestAttempts` implements the select-K policy.
 *  - arXiv 2508.21433 (JetBrains) — mechanical composition beats LLM summarization on cost at
 *    equal-or-better solve rate. Every function here is a pure string/array transform over
 *    telemetry the harness already persists on `Attempt` — no AI calls, no I/O.
 *
 * `Attempt.evaluation` persists only `status`/`file` (no per-criterion breakdown — that lives on
 * `Task.criteriaVerdicts`, a task-level aggregate across rounds, not addressable per attempt) and
 * `Attempt.commitSha` carries only the SHA (the generator's proposed commit subject is a transient
 * signal, never persisted onto the attempt). Both summaries below render only what the entity
 * actually carries — everything else degrades silently rather than guessing.
 *
 * @public
 */

/** Per-line clamp for the critique excerpt folded into one attempt's summary block. */
const CRITIQUE_MAX_CHARS = 240;

/** Short-sha display width — mirrors the `shortSha` convention in `render-round-outcome.ts`. */
const SHA_DISPLAY_LENGTH = 7;

/** Collapse whitespace and clamp free-form text to a single bounded line. */
const clampOneLine = (raw: string, max: number): string => {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

/** Human label per {@link AttemptWarning} kind — mirrors the discriminant docstring in `attempt.ts`. */
const WARNING_LABEL: Readonly<Record<AttemptWarning['kind'], string>> = {
  'budget-exhausted': 'turn budget exhausted',
  plateau: 'plateaued',
  malformed: 'evaluator output malformed',
  'verify-failed': 'post-task verify failed',
  crashed: 'process crashed',
};

const warningLine = (warning: AttemptWarning): string => {
  if (warning.kind === 'plateau' && warning.dimensions.length > 0) {
    return `warning: ${WARNING_LABEL.plateau} (${warning.dimensions.join(', ')})`;
  }
  return `warning: ${WARNING_LABEL[warning.kind]}`;
};

/**
 * Compact multi-line block for one attempt: attempt number + terminal status, then whichever of
 * attribution / critique / commit / warning / abort-cause the attempt actually carries, in that
 * order. Absent fields are skipped silently — never a placeholder like "unknown".
 *
 * Pure. No I/O.
 *
 * @public
 */
export const composeAttemptSummary = (attempt: Attempt): string => {
  const lines: string[] = [`Attempt ${String(attempt.n)}: ${attempt.status}`];
  if (attempt.attribution !== undefined) lines.push(`attribution: ${attempt.attribution}`);
  if (attempt.critique !== undefined && attempt.critique.trim().length > 0) {
    lines.push(`critique: ${clampOneLine(attempt.critique, CRITIQUE_MAX_CHARS)}`);
  }
  if (attempt.commitSha !== undefined) {
    lines.push(`commit: ${String(attempt.commitSha).slice(0, SHA_DISPLAY_LENGTH)}`);
  }
  if (attempt.warning !== undefined) lines.push(warningLine(attempt.warning));
  if (attempt.abortCause !== undefined) lines.push(`abort cause: ${attempt.abortCause}`);
  return lines.join('\n');
};

const isSettled = (attempt: Attempt): attempt is TerminalAttempt => attempt.status !== 'running';

/**
 * Attribution component of the select-K quality score. `clean` / `fixed-baseline` both mean the
 * attempt left the baseline green (equally good), `baseline-broken` means the attempt inherited a
 * pre-existing red baseline (not the attempt's fault, but not informative either), `regressed`
 * means the attempt broke a green baseline (worst signal to feed a retry).
 */
const ATTRIBUTION_SCORE: Readonly<Record<Attribution, number>> = {
  clean: 3,
  'fixed-baseline': 3,
  'baseline-broken': 1,
  regressed: 0,
};

/**
 * Score for an attempt whose attribution couldn't be determined (pre-verify spawn-error, skipped
 * check script) — ranks below a proven-clean/fixed attempt but above a proven-broken one.
 */
const ATTRIBUTION_SCORE_UNKNOWN = 2;

/** Status component of the select-K quality score — the secondary ranking signal. */
const STATUS_SCORE: Readonly<Record<TerminalAttempt['status'], number>> = {
  verified: 2,
  failed: 1,
  malformed: 0,
  aborted: 0,
};

/**
 * Weight that makes attribution the dominant ranking term: the widest status gap (2) can never
 * outrank the narrowest attribution gap (1) once multiplied.
 */
const ATTRIBUTION_WEIGHT = 10;

/**
 * Quality score backing the select-K policy (arXiv 2604.16529): attribution is primary, status is
 * secondary. No per-attempt evaluator-criteria pass-ratio term is computed — see the file docstring
 * for why that data isn't addressable per attempt.
 */
const qualityScore = (attempt: TerminalAttempt): number => {
  const attributionScore =
    attempt.attribution !== undefined ? ATTRIBUTION_SCORE[attempt.attribution] : ATTRIBUTION_SCORE_UNKNOWN;
  return attributionScore * ATTRIBUTION_WEIGHT + STATUS_SCORE[attempt.status];
};

/**
 * Select the K best attempts by quality score, per the select-K finding in arXiv 2604.16529.
 * Only settled attempts (`verified` / `failed` / `malformed` / `aborted`) participate — a `running`
 * attempt has no outcome to rank. Equal scores tie-break to the newest attempt (`n` descending)
 * before the cut, so a fresher same-quality attempt is preferred over an older one. `k <= 0` or an
 * empty/all-running input returns `[]`.
 *
 * The selected attempts are returned in CHRONOLOGICAL order (oldest first) so rendering reads as a
 * history, not a leaderboard.
 *
 * Pure. No I/O.
 *
 * @public
 */
export const selectKBestAttempts = (attempts: readonly Attempt[], k: number): Attempt[] => {
  const settled = attempts.filter(isSettled);
  const ranked = settled
    .map((attempt, index) => ({ attempt, index, score: qualityScore(attempt) }))
    .sort((a, b) => b.score - a.score || b.attempt.n - a.attempt.n || b.index - a.index);
  const selected = ranked.slice(0, Math.max(0, k));
  return selected.sort((a, b) => a.attempt.n - b.attempt.n || a.index - b.index).map((s) => s.attempt);
};

/** Selection width when the caller doesn't specify one. */
const DEFAULT_K = 3;

/**
 * Whole-section character ceiling. Engineering budget, not a paper finding — a backstop against a
 * pathological input (an attempt with an unusually long critique/warning chain), since `k` already
 * bounds attempt count and {@link CRITIQUE_MAX_CHARS} bounds the largest per-attempt field.
 */
const SECTION_MAX_CHARS = 2400;

const PRIOR_ATTEMPTS_HEADER =
  'Most instructive prior attempts on this task, with their verification outcomes — both what worked and what failed carry a verdict so the next attempt can build on the former and avoid repeating the latter:';

/** Options for {@link renderPriorAttemptsSection}. */
export interface RenderPriorAttemptsOptions {
  /** How many prior attempts to select. Defaults to {@link DEFAULT_K}. */
  readonly k?: number;
}

/**
 * Render the "prior attempts" section fed into a retry's prompt context: a header line, then the
 * K best-selected attempt summaries (oldest first). Empty string when there are no eligible
 * (settled) prior attempts, so callers can collapse the section cleanly.
 *
 * Pure. No I/O.
 *
 * @public
 */
export const renderPriorAttemptsSection = (
  attempts: readonly Attempt[],
  opts: RenderPriorAttemptsOptions = {}
): string => {
  const selected = selectKBestAttempts(attempts, opts.k ?? DEFAULT_K);
  if (selected.length === 0) return '';

  const body = [PRIOR_ATTEMPTS_HEADER, ...selected.map(composeAttemptSummary)].join('\n\n');
  return body.length > SECTION_MAX_CHARS ? `${body.slice(0, SECTION_MAX_CHARS - 1).trimEnd()}…` : body;
};
