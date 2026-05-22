import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Render an `EvaluationSignal` into operator-readable markdown (`evaluation.md`). Layout:
 *
 *     # Evaluation — <status>
 *
 *     **Overall score:** <n / 5> · <iso-timestamp>
 *
 *     ## Critique
 *     <critique prose>
 *
 *     ## Dimensions
 *
 *     ### <dimension name> — <score>/5 — <passed | failed>
 *     <finding>
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
export const renderEvaluationMarkdown = (signal: EvaluationSignal): string => {
  const lines: string[] = [];
  lines.push(`# Evaluation — ${signal.status}`);
  lines.push('');
  const overallScorePart =
    signal.overallScore !== undefined ? `**Overall score:** ${signal.overallScore.toFixed(1)} / 5` : '';
  const timestampPart = `_${String(signal.timestamp)}_`;
  const meta = [overallScorePart, timestampPart].filter((s) => s.length > 0).join(' · ');
  lines.push(meta);
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
      lines.push(`### ${d.dimension} — ${String(d.score)}/5 — ${d.passed ? 'passed' : 'failed'}`);
      if (d.finding.trim().length > 0) {
        lines.push('');
        lines.push(d.finding.trim());
      }
      lines.push('');
    }
  }

  return lines.join('\n');
};
