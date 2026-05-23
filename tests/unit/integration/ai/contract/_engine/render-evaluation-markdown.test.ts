import { describe, expect, it } from 'vitest';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { renderEvaluationMarkdown } from '@src/integration/ai/contract/_engine/render-evaluation-markdown.ts';

const ts = (): IsoTimestamp => {
  const r = IsoTimestamp.parse('2026-05-22T10:00:00.000Z');
  if (!r.ok) throw new Error('bad');
  return r.value;
};

describe('renderEvaluationMarkdown', () => {
  it('renders status, score, critique and dimensions', () => {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      overallScore: 4.5,
      critique: 'looks good overall',
      dimensions: [
        { dimension: 'correctness', score: 5, passed: true, finding: 'matches spec' },
        { dimension: 'tests', score: 4, passed: true, finding: 'coverage adequate' },
      ],
      timestamp: ts(),
    };
    const md = renderEvaluationMarkdown(signal);
    expect(md).toContain('# Evaluation — passed');
    expect(md).toContain('**Overall score:** 4.5 / 5');
    expect(md).toContain('## Critique');
    expect(md).toContain('looks good overall');
    expect(md).toContain('### correctness — 5/5 — passed');
    expect(md).toContain('matches spec');
    expect(md).toContain('### tests — 4/5 — passed');
  });

  it('omits the critique section when critique is absent', () => {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'malformed',
      dimensions: [],
      timestamp: ts(),
    };
    const md = renderEvaluationMarkdown(signal);
    expect(md).not.toContain('## Critique');
    expect(md).not.toContain('## Dimensions');
    expect(md).toContain('# Evaluation — malformed');
  });
});
