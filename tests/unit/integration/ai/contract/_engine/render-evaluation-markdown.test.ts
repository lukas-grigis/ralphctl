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
  it('renders status, critique, dimensions (no numeric score) and executionEvidence when present', () => {
    const signal: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      critique: 'looks good overall',
      dimensions: [
        {
          dimension: 'correctness',
          passed: true,
          finding: 'matches spec',
          executionEvidence: 'npm test\n  12 passing',
        },
        { dimension: 'tests', passed: true, finding: 'coverage adequate' },
      ],
      timestamp: ts(),
    };
    const md = renderEvaluationMarkdown(signal);
    expect(md).toContain('# Evaluation — passed');
    expect(md).not.toContain('Overall score');
    expect(md).not.toContain('/5');
    expect(md).toContain('## Critique');
    expect(md).toContain('looks good overall');
    expect(md).toContain('### correctness — passed');
    expect(md).toContain('matches spec');
    expect(md).toContain('### tests — passed');
    // Execution evidence renders inside a fenced block under the matching dimension row.
    expect(md).toContain('```\nnpm test\n  12 passing\n```');
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
