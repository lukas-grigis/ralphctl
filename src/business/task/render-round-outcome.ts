import type { Attempt, Evaluation } from '@src/domain/entity/attempt.ts';
import type { DimensionScore, EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Render an `outcome.md` for a single settled gen-eval round.
 *
 * Goal: a fresh agent (or a human postmortem reader) opens ONE file under
 * `<sprintDir>/implement/<task-id>/rounds/<n>/outcome.md` and knows what happened in that
 * round — verdict, evaluator dimensions, critique (if any), session ids, commit, duration.
 *
 * Pure — no IO. The synthesis paragraph is deterministic so identical inputs always render
 * the same string (vital for test determinism + regression-safe diffs across runs).
 *
 * `—` (em-dash) is used for missing optional fields rather than the empty string so the
 * markdown table aligns and the renderer reads as English ("session id: —") rather than
 * "session id: ".
 *
 * @public
 */
export interface RoundOutcomeInput {
  readonly roundN: number;
  readonly attemptN: number;
  readonly attempt: Attempt;
  /**
   * Verdict the harness decided for the attempt — typically derived from the evaluator
   * signal but may be the synthesised `plateau` when the inner loop detected the same failed
   * dimensions across two consecutive evaluations.
   */
  readonly verdict: RoundVerdict;
  /**
   * Optional in-memory evaluation signal carrying the structured dimension scores and
   * critique prose. Falls back to `attempt.evaluation` for the verdict status when this is
   * absent.
   */
  readonly evaluation?: EvaluationSignal;
  /** Generator session id for the round, when known. Missing → renders as `—`. */
  readonly generatorSessionId?: string;
  /** Evaluator session id for the round, when known. Missing → renders as `—`. */
  readonly evaluatorSessionId?: string;
  /** Total round duration in milliseconds. `undefined` → `—`. */
  readonly durationMs?: number;
}

/**
 * Round-level verdict. `passed` / `failed` mirror the evaluator's two terminal verdicts; the
 * synthesised `plateau` covers "two consecutive failed evals with identical failed-dimension
 * sets" which the harness handles distinctly.
 * @public
 */
export type RoundVerdict = 'passed' | 'failed' | 'plateau';

const EM_DASH = '—';

export const renderRoundOutcome = (input: RoundOutcomeInput): string => {
  const lines: string[] = [];
  lines.push(`# Round ${String(input.roundN)} · attempt ${String(input.attemptN)}`);
  lines.push('');
  lines.push(`- generator session: ${input.generatorSessionId ?? EM_DASH}`);
  lines.push(`- evaluator session: ${input.evaluatorSessionId ?? EM_DASH}`);
  lines.push(`- duration: ${formatDuration(input.durationMs)}`);
  lines.push(`- verdict: ${input.verdict}`);
  lines.push(`- commit: ${input.attempt.commitSha !== undefined ? String(input.attempt.commitSha) : EM_DASH}`);

  const dimensionsBlock = renderDimensions(input.evaluation, input.attempt.evaluation);
  if (dimensionsBlock !== undefined) {
    lines.push('');
    lines.push(...dimensionsBlock);
  }

  const critiqueBlock = renderCritique(input.verdict, input.evaluation, input.attempt.critique);
  if (critiqueBlock !== undefined) {
    lines.push('');
    lines.push(...critiqueBlock);
  }

  lines.push('');
  lines.push('## Synthesis');
  lines.push(synthesise(input));
  return `${lines.join('\n')}\n`;
};

const renderDimensions = (
  evaluation: EvaluationSignal | undefined,
  fallback: Evaluation | undefined
): readonly string[] | undefined => {
  const dimensions = evaluation?.dimensions ?? [];
  if (dimensions.length === 0) {
    if (fallback === undefined) return undefined;
    // Evaluation recorded on the attempt entity but no in-memory signal — keep the section
    // but mark it explicitly empty so the reader knows the verdict wasn't captured.
    return ['## Evaluator dimensions', '', '_No dimension verdicts recorded._'];
  }
  const rows: string[] = ['## Evaluator dimensions', '', '| dimension | verdict |', '|---|---|'];
  for (const d of dimensions) {
    rows.push(`| ${dimensionLabel(d)} | ${d.passed ? 'PASS' : 'FAIL'} |`);
  }
  return rows;
};

const dimensionLabel = (d: DimensionScore): string => (d.dimension.length > 0 ? d.dimension : 'unnamed');

const renderCritique = (
  verdict: RoundVerdict,
  evaluation: EvaluationSignal | undefined,
  attemptCritique: string | undefined
): readonly string[] | undefined => {
  if (verdict === 'passed') return undefined;
  const text = (evaluation?.critique ?? attemptCritique ?? '').trim();
  if (text.length === 0) {
    return ['## Critique', '', '_No critique text emitted by the evaluator._'];
  }
  return ['## Critique', '', ...text.split('\n').map((line) => `> ${line}`)];
};

/**
 * One-sentence deterministic summary. Examples:
 *  - "Round 2 of attempt 1 passed all evaluator dimensions and committed abc1234."
 *  - "Round 1 of attempt 1 failed completeness 3/5; critique persisted, round 2 will retry."
 *  - "Round 3 of attempt 2 plateaued on correctness, completeness; harness gave up after 2
 *     identical failed evaluations."
 */
const synthesise = (input: RoundOutcomeInput): string => {
  const base = `Round ${String(input.roundN)} of attempt ${String(input.attemptN)}`;
  if (input.verdict === 'passed') {
    const commit =
      input.attempt.commitSha !== undefined ? ` and committed ${shortSha(String(input.attempt.commitSha))}` : '';
    return `${base} passed all evaluator dimensions${commit}.`;
  }
  if (input.verdict === 'plateau') {
    const failedDims = collectFailedDimensions(input.evaluation);
    const dims = failedDims.length > 0 ? ` on ${failedDims.join(', ')}` : '';
    return `${base} plateaued${dims}; harness gave up after 2 identical failed evaluations.`;
  }
  // failed
  const failedDims = collectFailedDimensions(input.evaluation);
  if (failedDims.length === 0) {
    return `${base} failed without dimension verdicts; critique persisted, round ${String(input.roundN + 1)} will retry.`;
  }
  const detail = formatFailedDimensions(input.evaluation);
  return `${base} failed on ${detail}; critique persisted, round ${String(input.roundN + 1)} will retry.`;
};

const collectFailedDimensions = (evaluation: EvaluationSignal | undefined): readonly string[] => {
  if (evaluation === undefined) return [];
  return evaluation.dimensions.filter((d) => !d.passed).map((d) => dimensionLabel(d));
};

const formatFailedDimensions = (evaluation: EvaluationSignal | undefined): string => {
  if (evaluation === undefined) return 'evaluator dimensions';
  const failed = evaluation.dimensions.filter((d) => !d.passed);
  if (failed.length === 0) return 'evaluator dimensions';
  return failed.map((d) => dimensionLabel(d)).join(', ');
};

const SHA_DISPLAY_LENGTH = 7;
const shortSha = (sha: string): string => sha.slice(0, SHA_DISPLAY_LENGTH);

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Human-readable duration. Mirrors `render-progress-markdown.ts`'s formatter for consistency. */
const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return EM_DASH;
  if (ms < 0) return `${String(ms)}ms`;
  if (ms < MS_PER_SECOND) return `${String(ms)}ms`;
  if (ms < MS_PER_MINUTE) {
    return `${String(Math.floor(ms / MS_PER_SECOND))}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(minutes)}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
};
