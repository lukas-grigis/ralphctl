/**
 * Round-trip fence over the `evaluation.md` contract.
 *
 * `renderEvaluationMarkdown` (integration) writes the file; `parseEvaluationMarkdown` (business)
 * reads it back for the TUI overlay and the `task evaluation` CLI command. The two live in
 * different layers with no shared type, so nothing but this test stops them drifting apart.
 *
 * It also pins the two KNOWN losses explicitly, so the lossiness stays a documented decision
 * rather than an accident someone "fixes" by fabricating data on the read side.
 */

import { describe, expect, it } from 'vitest';
import { renderEvaluationMarkdown } from '@src/integration/ai/contract/_engine/render-evaluation-markdown.ts';
import { parseEvaluationMarkdown } from '@src/business/task/parse-evaluation-md.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const TIMESTAMP = '2026-08-17T09:15:00.000Z' as IsoTimestamp;

const signal = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  timestamp: TIMESTAMP,
  critique: 'The legacy migration path is untested.\n\nSecond paragraph of the critique.',
  criteria: [
    { id: 'AC-1', passed: true, evidence: 'covered by the new unit test' },
    { id: 'AC-2', passed: false, evidence: 'no test touches the legacy row' },
  ],
  dimensions: [
    { dimension: 'correctness', passed: true, finding: 'Logic matches the acceptance criteria.' },
    {
      dimension: 'tests',
      passed: false,
      finding: 'No regression test for the legacy row.',
      executionEvidence: 'FAIL tests/unit/foo.test.ts\n  1 failed',
    },
    { dimension: 'docs', passed: false, applicable: false, finding: 'No documentation surface in scope.' },
  ],
});

describe('evaluation.md round-trip — render → parse', () => {
  it('preserves status, timestamp and critique verbatim', () => {
    const parsed = parseEvaluationMarkdown(renderEvaluationMarkdown(signal()));
    expect(parsed.status).toBe('failed');
    expect(parsed.timestamp).toBe(TIMESTAMP);
    expect(parsed.critique).toBe('The legacy migration path is untested.\n\nSecond paragraph of the critique.');
  });

  it('preserves every dimension name, verdict, finding and evidence block', () => {
    const parsed = parseEvaluationMarkdown(renderEvaluationMarkdown(signal()));
    expect(parsed.dimensions).toEqual([
      {
        dimension: 'correctness',
        verdict: 'passed',
        finding: 'Logic matches the acceptance criteria.',
      },
      {
        dimension: 'tests',
        verdict: 'failed',
        finding: 'No regression test for the legacy row.',
        evidence: 'FAIL tests/unit/foo.test.ts\n  1 failed',
      },
      {
        dimension: 'docs',
        verdict: 'n/a',
        finding: 'No documentation surface in scope.',
      },
    ]);
  });

  it('round-trips a passed evaluation with no critique and no dimensions', () => {
    const bare: EvaluationSignal = { type: 'evaluation', status: 'passed', timestamp: TIMESTAMP, dimensions: [] };
    const parsed = parseEvaluationMarkdown(renderEvaluationMarkdown(bare));
    expect(parsed.status).toBe('passed');
    expect(parsed.critique).toBeUndefined();
    expect(parsed.dimensions).toEqual([]);
  });

  describe('known, deliberate losses', () => {
    it('drops per-criterion verdicts entirely — the renderer never emits them', () => {
      const markdown = renderEvaluationMarkdown(signal());
      expect(markdown).not.toContain('AC-1');
      expect(markdown).not.toContain('AC-2');
      // Nothing on the parsed model can carry them back, by construction.
      expect(Object.keys(parseEvaluationMarkdown(markdown))).not.toContain('criteria');
    });

    it('collapses `applicable: false` onto the literal verdict `n/a`, losing the boolean', () => {
      const parsed = parseEvaluationMarkdown(renderEvaluationMarkdown(signal()));
      const docs = parsed.dimensions.find((d) => d.dimension === 'docs');
      // The source signal carried BOTH `passed: false` and `applicable: false`; only the
      // not-applicable half survives, which is the half an operator needs.
      expect(docs?.verdict).toBe('n/a');
    });
  });
});
