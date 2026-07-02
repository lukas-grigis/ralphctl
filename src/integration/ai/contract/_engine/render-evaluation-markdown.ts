import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Render an `EvaluationSignal` into operator-readable markdown (`evaluation.md`). Layout:
 *
 *     # Evaluation — <status>
 *
 *     _<iso-timestamp>_
 *
 *     ## Critique
 *     <critique prose>
 *
 *     ## Dimensions
 *
 *     ### <dimension name> — <passed | failed | n/a>
 *     <finding>
 *
 *     ```
 *     <execution evidence — when present>
 *     ```
 *
 *     ### …
 *
 * The structured-to-markdown transform lives here so the evaluator leaf's contract can plug
 * this in as the `extract` for its `evaluation.md` sidecar without inlining the prose
 * convention at the leaf's call site.
 *
 * Empty sections are omitted entirely. The output has a trailing newline so editors line-
 * count cleanly.
 */
/** `n/a` for an explicit not-applicable dimension, otherwise the ordinary passed/failed verdict. */
const dimensionVerdict = (d: EvaluationSignal['dimensions'][number]): string => {
  if (d.applicable === false) return 'n/a';
  return d.passed ? 'passed' : 'failed';
};

export const renderEvaluationMarkdown = (signal: EvaluationSignal): string => {
  const lines: string[] = [];
  lines.push(`# Evaluation — ${signal.status}`);
  lines.push('');
  lines.push(`_${String(signal.timestamp)}_`);
  lines.push('');

  if (signal.critique !== undefined && signal.critique.trim().length > 0) {
    lines.push('## Critique');
    lines.push('');
    lines.push(signal.critique.trim());
    lines.push('');
  }

  if (signal.dimensions.length > 0) {
    lines.push('## Dimensions');
    lines.push('');
    for (const d of signal.dimensions) {
      lines.push(`### ${d.dimension} — ${dimensionVerdict(d)}`);
      if (d.finding.trim().length > 0) {
        lines.push('');
        lines.push(d.finding.trim());
      }
      if (d.executionEvidence !== undefined && d.executionEvidence.trim().length > 0) {
        lines.push('');
        lines.push('```');
        lines.push(d.executionEvidence.trim());
        lines.push('```');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
};
