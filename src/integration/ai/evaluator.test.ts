import { describe, expect, it } from 'vitest';
import { parseDimensionScores, parseEvaluationResult } from './evaluator.ts';

// ============================================================================
// parseDimensionScores
// ============================================================================

describe('parseDimensionScores', () => {
  it('parses all four dimensions from well-formed output', () => {
    const output = [
      '## Assessment',
      '',
      '**Correctness**: PASS — All criteria verified',
      '**Completeness**: PASS — All steps implemented',
      '**Safety**: PASS — No vulnerabilities found',
      '**Consistency**: FAIL — Uses snake_case instead of camelCase',
    ].join('\n');

    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(4);
    expect(scores[0]).toMatchObject({ dimension: 'correctness', passed: true, finding: 'All criteria verified' });
    expect(scores[3]).toMatchObject({
      dimension: 'consistency',
      passed: false,
      finding: 'Uses snake_case instead of camelCase',
    });
  });

  it('returns empty array when no dimension lines are present', () => {
    const scores = parseDimensionScores('Some random output with no dimensions');
    expect(scores).toEqual([]);
  });

  it('handles partial dimension output (only some dimensions present)', () => {
    const output = '**Correctness**: PASS — Looks good\n**Safety**: FAIL — SQL injection at line 42';
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({ dimension: 'correctness' });
    expect(scores[1]).toMatchObject({ dimension: 'safety' });
  });

  it('is case-insensitive for PASS/FAIL', () => {
    const output = '**Correctness**: pass — ok\n**Safety**: Fail — issue';
    const scores = parseDimensionScores(output);
    expect(scores[0]).toMatchObject({ passed: true });
    expect(scores[1]).toMatchObject({ passed: false });
  });

  it('handles hyphen instead of em-dash as separator', () => {
    const output = '**Correctness**: PASS - All good';
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ dimension: 'correctness', passed: true, finding: 'All good' });
  });

  it('parses planner-emitted extra dimensions when no floor dimensions are present', () => {
    // Extras-only output — the four floor names never appear, but plateau
    // detection still needs the failed-dimension set to reach it.
    const output = [
      '**Performance**: FAIL — p99 regressed by 40ms',
      '**Accessibility**: PASS — landmarks present',
    ].join('\n');
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({ dimension: 'performance', passed: false, finding: 'p99 regressed by 40ms' });
    expect(scores[1]).toMatchObject({ dimension: 'accessibility', passed: true, finding: 'landmarks present' });
  });

  it('parses mixed floor + extra dimensions in a single output', () => {
    const output = [
      '**Correctness**: PASS — All assertions pass',
      '**Completeness**: PASS — All steps implemented',
      '**Safety**: PASS — No vulnerabilities',
      '**Consistency**: PASS — Follows conventions',
      '**Performance**: FAIL — p99 latency above target',
    ].join('\n');
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(5);
    expect(scores.map((s) => s.dimension)).toEqual([
      'correctness',
      'completeness',
      'safety',
      'consistency',
      'performance',
    ]);
    expect(scores[4]).toMatchObject({ dimension: 'performance', passed: false });
  });

  it('parses a stray bold-text dimension line outside an assessment context', () => {
    // Documented behaviour — the parser is line-shaped, so a single
    // `**Note**: PASS — something` will be captured even when not part of an
    // Assessment block. Surrounding prose is the agent's responsibility.
    const output = 'Misc commentary…\n**Note**: PASS — pre-flight check ran cleanly';
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ dimension: 'note', passed: true, finding: 'pre-flight check ran cleanly' });
  });

  it('de-duplicates by lowercased dimension name (first occurrence wins)', () => {
    const output = [
      '**Correctness**: PASS — first finding',
      '**correctness**: FAIL — duplicate (should be ignored)',
    ].join('\n');
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ dimension: 'correctness', passed: true, finding: 'first finding' });
  });
});

// ============================================================================
// parseEvaluationResult
// ============================================================================

describe('parseEvaluationResult', () => {
  it('returns passed=true for <evaluation-passed> signal', () => {
    const output = '<evaluation-passed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('<evaluation-passed>');
  });

  it('returns passed=false for <evaluation-failed> signal with critique', () => {
    const critique = 'Missing error handling in main function';
    const output = `<evaluation-failed>${critique}</evaluation-failed>`;
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe(critique);
  });

  it('extracts critique text from failed signal embedded in surrounding context', () => {
    const critique = 'Line 42: Off-by-one error in loop';
    const output = `Some context\n<evaluation-failed>${critique}</evaluation-failed>\nMore context`;
    const result = parseEvaluationResult(output);
    expect(result.output).toBe(critique);
  });

  it('handles multiline critique in failed signal', () => {
    const critique = `Issue 1: Missing validation\nIssue 2: Unhandled edge case`;
    const output = `<evaluation-failed>${critique}</evaluation-failed>`;
    const result = parseEvaluationResult(output);
    expect(result.output).toContain('Issue 1');
    expect(result.output).toContain('Issue 2');
  });

  it('returns passed=false with original output when no signal found', () => {
    const output = 'Random AI output with no signals';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe(output);
  });

  it('evaluation-passed takes precedence when both signals are present', () => {
    const output = '<evaluation-passed>\n<evaluation-failed>this should not matter</evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
  });

  it('handles empty critique text in failed signal', () => {
    const output = '<evaluation-failed></evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe('');
  });

  it('trims whitespace from critique extracted from failed signal', () => {
    const output = '<evaluation-failed>  leading and trailing spaces  </evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.output).toBe('leading and trailing spaces');
  });

  it('handles evaluation-passed with surrounding prose', () => {
    const output = 'I reviewed the code.\n<evaluation-passed>\nLooks good overall.';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
  });

  it('includes dimension scores when present in output', () => {
    const output = [
      '## Assessment',
      '**Correctness**: PASS — All good',
      '**Completeness**: PASS — Done',
      '**Safety**: PASS — Secure',
      '**Consistency**: PASS — Follows patterns',
      '<evaluation-passed>',
    ].join('\n');

    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions.every((d) => d.passed)).toBe(true);
  });

  it('includes dimension scores in failed evaluation', () => {
    const output = [
      '**Correctness**: FAIL — Off-by-one in loop',
      '**Completeness**: PASS — All steps done',
      '**Safety**: PASS — No issues',
      '**Consistency**: PASS — Follows patterns',
      '<evaluation-failed>Off-by-one error at line 42</evaluation-failed>',
    ].join('\n');

    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions[0]).toMatchObject({ passed: false });
  });

  it('returns empty dimensions array when no dimension lines present', () => {
    const output = '<evaluation-passed>';
    const result = parseEvaluationResult(output);
    expect(result.dimensions).toEqual([]);
  });

  it('returns status=passed for the passed signal', () => {
    expect(parseEvaluationResult('<evaluation-passed>').status).toBe('passed');
  });

  it('returns status=failed for the failed signal', () => {
    expect(parseEvaluationResult('<evaluation-failed>x</evaluation-failed>').status).toBe('failed');
  });

  it('returns status=failed when no signal but dimensions parsed', () => {
    const output = '**Correctness**: FAIL — bug at line 1';
    const result = parseEvaluationResult(output);
    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
  });

  it('returns status=malformed when neither signal nor dimensions found', () => {
    const result = parseEvaluationResult('Random output with no structure');
    expect(result.status).toBe('malformed');
    expect(result.passed).toBe(false);
    expect(result.dimensions).toEqual([]);
  });
});
