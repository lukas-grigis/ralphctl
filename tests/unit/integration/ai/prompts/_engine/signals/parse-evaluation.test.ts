import { describe, expect, it } from 'vitest';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { evaluationParser } from '@tests/helpers/legacy-signal-parsers/evaluation/parser.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const evalSignal = (matches: ReturnType<typeof evaluationParser.parse>): EvaluationSignal => {
  expect(matches).toHaveLength(1);
  const sig = matches[0]?.signal;
  if (sig === undefined || sig.type !== 'evaluation') throw new Error('expected evaluation signal');
  return sig;
};

describe('evaluationParser', () => {
  it('emits no signal when neither verdict nor dimensions appear', () => {
    expect(evaluationParser.parse('Just narrative.\n\n', NOW)).toEqual([]);
  });

  it('emits passed verdict with no dimensions when only the verdict signal is present', () => {
    const matches = evaluationParser.parse('All good. <evaluation-passed>', NOW);
    const sig = evalSignal(matches);
    expect(sig.status).toBe('passed');
    expect(sig.dimensions).toEqual([]);
    expect(sig.overallScore).toBeUndefined();
    expect(sig.critique).toBeUndefined();
  });

  it('emits failed verdict with critique', () => {
    const text = `<evaluation-failed>
Missing test for the empty case.
</evaluation-failed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.status).toBe('failed');
    expect(sig.critique).toBe('Missing test for the empty case.');
  });

  it('extracts dimensions from "### Name — passed (5)" headings', () => {
    const text = `## Findings

### Correctness — passed (5)

Implementation matches every verification criterion in scope.

### Completeness — failed (3)

Missing the edge case for empty input list. Add a test.

### Safety — passed (4)

No injection risk; inputs validated.

### Consistency — passed (5)

Matches the existing module style.

<evaluation-failed>
Completeness gap on empty input — see Findings.
</evaluation-failed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.status).toBe('failed');
    expect(sig.dimensions).toEqual([
      {
        dimension: 'correctness',
        score: 5,
        passed: true,
        finding: 'Implementation matches every verification criterion in scope.',
      },
      {
        dimension: 'completeness',
        score: 3,
        passed: false,
        finding: 'Missing the edge case for empty input list. Add a test.',
      },
      { dimension: 'safety', score: 4, passed: true, finding: 'No injection risk; inputs validated.' },
      { dimension: 'consistency', score: 5, passed: true, finding: 'Matches the existing module style.' },
    ]);
    expect(sig.overallScore).toBe(4.3);
  });

  it('handles dynamic per-task dimensions alongside floor', () => {
    const text = `### Correctness — passed (5)

Solid.

### Performance — failed (2)

Quadratic loop on the hot path.

<evaluation-failed>
Performance regression — convert to a single pass.
</evaluation-failed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.dimensions.map((d) => d.dimension)).toEqual(['correctness', 'performance']);
    expect(sig.dimensions[1]?.passed).toBe(false);
  });

  it('marks status:malformed when dimensions appear but no verdict signal is emitted', () => {
    const text = `### Correctness — passed (5)

Looks fine.`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.status).toBe('malformed');
    expect(sig.dimensions).toHaveLength(1);
  });

  it('drops dimension lines with out-of-range scores (0 / 6+)', () => {
    const text = `### Foo — passed (0)

Bad.

### Bar — passed (5)

Good.

<evaluation-passed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.dimensions.map((d) => d.dimension)).toEqual(['bar']);
  });

  it('deduplicates dimensions by lowercased name (first match wins)', () => {
    const text = `### Correctness — passed (5)

First.

### correctness — failed (2)

Duplicate.

<evaluation-passed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.dimensions).toHaveLength(1);
    expect(sig.dimensions[0]?.score).toBe(5);
  });

  it('caps very long findings at 240 chars with an ellipsis', () => {
    const longFinding = 'x'.repeat(500);
    const text = `### Correctness — passed (5)

${longFinding}

<evaluation-passed>`;
    const sig = evalSignal(evaluationParser.parse(text, NOW));
    expect(sig.dimensions[0]?.finding.endsWith('...')).toBe(true);
    expect(sig.dimensions[0]?.finding.length).toBe(240);
  });
});
