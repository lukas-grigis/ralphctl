import type { EvaluationStatus } from '@src/domain/models.ts';

/**
 * Evaluator-output parser.
 *
 * Everything in this module is pure: given the evaluator's raw stdout, return
 * a structured `EvaluationResult`. The evaluator spawn/ladder logic moved to
 * `src/business/usecases/evaluate.ts`; only the parser remains here and is
 * consumed by `DefaultOutputParserAdapter.parseEvaluation()`.
 */

// ============================================================================
// Evaluation Result Parsing
// ============================================================================

/**
 * Evaluation dimension name — any identifier parsed from a
 * `**Name**: PASS|FAIL — finding` line, including planner-emitted extras.
 * Re-exported for backward compatibility with consumers that previously
 * imported the four-name literal union.
 */
type EvaluationDimension = string;

/** Per-dimension score parsed from evaluator output. */
interface DimensionScore {
  dimension: EvaluationDimension;
  passed: boolean;
  finding: string;
}

/**
 * Discriminator semantics for `EvaluationStatus`:
 * - `passed`   — `<evaluation-passed>` signal present.
 * - `failed`   — `<evaluation-failed>` signal present, OR partial dimensions parsed but no signal.
 * - `malformed`— neither signal AND no dimension lines parsed (unusable evaluator output).
 *
 * Note: `'plateau'` is NOT a parser outcome — it's loop-derived by the
 * `EvaluateTaskUseCase` when the same failures recur across iterations. The
 * parser status is deliberately narrower than the persisted `EvaluationStatus`.
 */
type ParsedEvaluationStatus = Exclude<EvaluationStatus, 'plateau'>;

interface EvaluationResult {
  passed: boolean;
  status: ParsedEvaluationStatus;
  output: string;
  /** Per-dimension scores when structured assessment is present. */
  dimensions: DimensionScore[];
}

/**
 * Generic dimension regex — captures `**Name**: PASS|FAIL [— finding]` lines.
 *
 * - Name: 3–30 chars (`[A-Za-z][A-Za-z0-9]{2,29}`) — wide enough for the four
 *   floor dimensions and planner-emitted extras (`Performance`,
 *   `Accessibility`, `MigrationSafety`, …), narrow enough to skip noise like
 *   `**ok**` or huge bold strings.
 * - PASS/FAIL: case-insensitive (existing prompts emit both `PASS` and `pass`).
 * - Separator + finding: em-dash (`—`) or ASCII hyphen (`-`) followed by the
 *   finding text — OPTIONAL at the regex level so bare `**Name**: PASS` lines
 *   can still be captured by the parser. The anti-rubber-stamp contract
 *   (see `task-evaluation.md`) demands a non-empty finding after the
 *   separator; `parseDimensionScores` enforces that by forcing `passed=false`
 *   when the finding is missing or whitespace-only, so bare-PASS output fails
 *   instead of silently sliding through.
 * - Finding: any non-newline chars ending on a non-whitespace char.
 *
 * The leading-capital intent (filter out random bold prose like `**note**`) is
 * weakened by the case-insensitive flag — that's accepted by design, since the
 * parser is line-shaped and the surrounding prose is the agent's
 * responsibility (see noise-case test). The 3–30 char bound and the bold-text
 * requirement are the load-bearing noise filters.
 *
 * Captured name is lowercased so downstream comparisons (e.g. plateau
 * detection) stay case-insensitive.
 */
const DIMENSION_LINE = /\*\*([A-Za-z][A-Za-z0-9]{2,29})\*\*\s*:\s*(PASS|FAIL)(?:\s*(?:—|-)\s*([^\n]*\S))?/gi;

/**
 * Parse structured dimension scores from evaluator output.
 *
 * Matches every `**Name**: PASS|FAIL — finding` line in the input. Names are
 * lowercased; duplicates collapse to the first occurrence so `**Correctness**`
 * and `**correctness**` in the same output produce a single entry. Order
 * preserved by first occurrence.
 */
export function parseDimensionScores(output: string): DimensionScore[] {
  const scores: DimensionScore[] = [];
  const seen = new Set<string>();
  // RegExp.prototype.exec with /g is stateful — reset before each pass so the
  // function stays pure.
  DIMENSION_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIMENSION_LINE.exec(output)) !== null) {
    const rawName = match[1];
    const verdict = match[2];
    // `match[3]` is undefined when the line has no separator+finding
    // (e.g. bare `**Correctness**: PASS`). That's a contract violation —
    // the evaluator prompt requires a justification after the separator —
    // so we keep the dimension but force `passed=false` to surface it.
    const finding = (match[3] ?? '').trim();
    if (!rawName || !verdict) continue;
    const name = rawName.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const hasJustification = finding.length > 0;
    scores.push({
      dimension: name,
      passed: verdict.toUpperCase() === 'PASS' && hasJustification,
      finding,
    });
  }
  return scores;
}

/**
 * Parse evaluator AI output for evaluation signals and dimension scores.
 * Checks for <evaluation-passed> or <evaluation-failed>...</evaluation-failed>.
 * Also extracts structured dimension scores when present.
 *
 * Returns `status: 'malformed'` only when BOTH signals are missing AND no
 * dimension lines parsed — that's the case where the evaluator output is
 * effectively unusable. A failed dimension assessment without a signal is
 * still treated as `failed` (the assessment carries enough signal on its own).
 */
export function parseEvaluationResult(output: string): EvaluationResult {
  const dimensions = parseDimensionScores(output);

  // Check for passed signal
  if (output.includes('<evaluation-passed>')) {
    return { passed: true, status: 'passed', output, dimensions };
  }

  // Check for failed signal with critique
  const failedMatch = /<evaluation-failed>([\s\S]*?)<\/evaluation-failed>/.exec(output);
  if (failedMatch) {
    return { passed: false, status: 'failed', output: failedMatch[1]?.trim() ?? output, dimensions };
  }

  // No signal — but if dimensions parsed, we still have actionable data → 'failed'
  if (dimensions.length > 0) {
    return { passed: false, status: 'failed', output, dimensions };
  }

  // Neither signal nor dimensions: evaluator output is unusable
  return { passed: false, status: 'malformed', output, dimensions };
}
