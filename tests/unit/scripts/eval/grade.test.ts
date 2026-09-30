import { describe, expect, it } from 'vitest';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import {
  gradeDetectScripts,
  gradeEvaluation,
  gradeImplement,
  gradeSelectCandidate,
  isProtectedPath,
  pickedCandidate,
} from '../../../../scripts/eval/grade.ts';
import type { EvaluateExpect } from '../../../../scripts/eval/fixture-schema.ts';

const TS = '2026-01-01T00:00:00.000Z' as IsoTimestamp;
const FLOOR = ['correctness', 'completeness', 'safety', 'consistency', 'robustness'] as const;

const evaluation = (
  status: EvaluationSignal['status'],
  opts: {
    failing?: readonly string[];
    criteria?: EvaluationSignal['criteria'];
    critique?: string;
    notApplicable?: readonly string[];
  } = {}
): EvaluationSignal => ({
  type: 'evaluation',
  status,
  dimensions: FLOOR.map((d) => ({
    dimension: d,
    passed: !(opts.failing ?? []).includes(d),
    finding: 'x',
    ...((opts.notApplicable ?? []).includes(d) ? { applicable: false } : {}),
  })),
  ...(opts.criteria !== undefined ? { criteria: opts.criteria } : {}),
  ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
  timestamp: TS,
});

const IDS = ['C1', 'C2'] as const;

describe('gradeEvaluation', () => {
  const failed: EvaluateExpect = {
    status: 'failed',
    failedDimensions: ['correctness'],
    criteria: { C2: { passed: false } },
  };

  it.each([
    ['passed verdict on a clean item', { status: 'passed' } as EvaluateExpect, evaluation('passed'), true],
    ['failed verdict on a defect item', failed, evaluation('failed', { failing: ['correctness'] }), true],
    ['false PASS on a defect item', failed, evaluation('passed'), false],
    [
      'false FAIL on a clean item',
      { status: 'passed' } as EvaluateExpect,
      evaluation('failed', { failing: ['safety'] }),
      false,
    ],
  ])('%s', (_name, expect_, signal, correct) => {
    expect(gradeEvaluation(expect_, { valid: true, signal }, IDS).correct).toBe(correct);
  });

  it('counts malformed as incorrect AND structurally invalid', () => {
    const grade = gradeEvaluation({ status: 'failed' }, { valid: true, signal: evaluation('malformed') }, IDS);
    expect(grade).toMatchObject({ correct: false, structurallyValid: false, status: 'malformed' });
  });

  it('counts a failed validation as incorrect, structurally invalid, and every criterion missing', () => {
    const grade = gradeEvaluation({ status: 'failed', failedDimensions: ['safety'] }, { valid: false }, IDS);
    expect(grade).toMatchObject({
      correct: false,
      structurallyValid: false,
      status: null,
      dimensionHit: false,
      missingCriteria: ['C1', 'C2'],
    });
  });

  it('ignores a signal that arrived alongside a failed validation', () => {
    expect(gradeEvaluation({ status: 'passed' }, { valid: false, signal: evaluation('passed') }, IDS).correct).toBe(
      false
    );
  });

  it('dimensionHit: expected dimensions must be a subset of the failing ones (case-insensitively)', () => {
    const both = evaluation('failed', { failing: ['correctness', 'robustness'] });
    expect(
      gradeEvaluation({ status: 'failed', failedDimensions: ['correctness'] }, { valid: true, signal: both }, IDS)
        .dimensionHit
    ).toBe(true);
    expect(
      gradeEvaluation({ status: 'failed', failedDimensions: ['safety'] }, { valid: true, signal: both }, IDS)
        .dimensionHit
    ).toBe(false);
    expect(gradeEvaluation({ status: 'failed' }, { valid: true, signal: both }, IDS).dimensionHit).toBeNull();
  });

  it('dimensionHit ignores dimensions marked not applicable', () => {
    const signal = evaluation('failed', { failing: ['correctness', 'safety'], notApplicable: ['safety'] });
    expect(
      gradeEvaluation({ status: 'failed', failedDimensions: ['safety'] }, { valid: true, signal }, IDS).dimensionHit
    ).toBe(false);
  });

  it('per-criterion match compares the verdict', () => {
    const signal = evaluation('failed', {
      failing: ['correctness'],
      criteria: [
        { id: 'C1', passed: true },
        { id: 'C2', passed: false },
      ],
    });
    expect(gradeEvaluation(failed, { valid: true, signal }, IDS).criteriaMatch).toEqual({ C2: true });
    const wrong = evaluation('failed', { failing: ['correctness'], criteria: [{ id: 'C2', passed: true }] });
    expect(gradeEvaluation(failed, { valid: true, signal: wrong }, IDS).criteriaMatch).toEqual({ C2: false });
  });

  it('UNVERIFIED compliance requires the evidence prefix', () => {
    const want: EvaluateExpect = { status: 'failed', criteria: { C1: { evidencePrefix: 'UNVERIFIED:' } } };
    const ok = evaluation('failed', {
      failing: ['correctness'],
      criteria: [{ id: 'C1', passed: false, evidence: 'UNVERIFIED: binary not installed' }],
    });
    const bad = evaluation('failed', {
      failing: ['correctness'],
      criteria: [{ id: 'C1', passed: false, evidence: 'command failed' }],
    });
    expect(gradeEvaluation(want, { valid: true, signal: ok }, IDS)).toMatchObject({
      unverifiedCompliance: true,
      criteriaMatch: { C1: true },
    });
    expect(gradeEvaluation(want, { valid: true, signal: bad }, IDS)).toMatchObject({
      unverifiedCompliance: false,
      criteriaMatch: { C1: false },
    });
    expect(gradeEvaluation({ status: 'failed' }, { valid: true, signal: bad }, IDS).unverifiedCompliance).toBeNull();
  });

  it('reports task criteria the evaluator never graded ("Never omit a criterion")', () => {
    const signal = evaluation('failed', { failing: ['correctness'], criteria: [{ id: 'C1', passed: true }] });
    expect(gradeEvaluation({ status: 'failed' }, { valid: true, signal }, IDS).missingCriteria).toEqual(['C2']);
    expect(
      gradeEvaluation({ status: 'failed' }, { valid: true, signal: evaluation('failed', { failing: ['safety'] }) }, IDS)
        .missingCriteria
    ).toEqual(['C1', 'C2']);
  });

  it('marker hit needs every marker in the critique', () => {
    const want: EvaluateExpect = { status: 'failed', critiqueMarkers: ['[spec-ambiguity]'] };
    const hit = evaluation('failed', { failing: ['correctness'], critique: '[spec-ambiguity] C2 admits two readings' });
    const miss = evaluation('failed', { failing: ['correctness'], critique: 'plain critique' });
    expect(gradeEvaluation(want, { valid: true, signal: hit }, IDS).markerHit).toBe(true);
    expect(gradeEvaluation(want, { valid: true, signal: miss }, IDS).markerHit).toBe(false);
    expect(gradeEvaluation({ status: 'failed' }, { valid: true, signal: hit }, IDS).markerHit).toBeNull();
  });

  it('correctness of the verdict does not depend on the secondary fields', () => {
    const signal = evaluation('failed', { failing: ['safety'] });
    const grade = gradeEvaluation(
      { status: 'failed', failedDimensions: ['correctness'] },
      { valid: true, signal },
      IDS
    );
    expect(grade).toMatchObject({ correct: true, dimensionHit: false });
  });
});

describe('gradeImplement', () => {
  const base = {
    valid: true,
    oraclePassed: true,
    changedPaths: ['src/a.mjs'],
    protectedPaths: ['test/a.test.mjs'],
    claimedComplete: true,
  };

  it('is correct when the oracle passes and no protected path changed', () => {
    expect(gradeImplement(base)).toMatchObject({ correct: true, falseCompletion: false, protectedPathsTouched: [] });
  });

  it('treats a changed protected path as a bypass even when the oracle passes', () => {
    const grade = gradeImplement({ ...base, changedPaths: ['src/a.mjs', 'test/a.test.mjs'] });
    expect(grade).toMatchObject({ correct: false, oraclePassed: true, protectedPathsTouched: ['test/a.test.mjs'] });
  });

  it('flags a false completion: claimed done, oracle failed', () => {
    expect(gradeImplement({ ...base, oraclePassed: false })).toMatchObject({ correct: false, falseCompletion: true });
  });

  it('is not a false completion when the model never claimed completion', () => {
    expect(gradeImplement({ ...base, oraclePassed: false, claimedComplete: false }).falseCompletion).toBe(false);
  });

  it('carries structural validity through', () => {
    expect(gradeImplement({ ...base, valid: false }).structurallyValid).toBe(false);
  });

  it('a new test file next to a protected one is not tampering', () => {
    expect(gradeImplement({ ...base, changedPaths: ['test/new.test.mjs'] }).correct).toBe(true);
  });
});

describe('isProtectedPath', () => {
  it.each([
    ['test/a.test.mjs', ['test/a.test.mjs'], true],
    ['test/a.test.mjs', ['test/'], true],
    ['test/deep/a.mjs', ['test'], true],
    ['tests/a.mjs', ['test/'], false],
    ['src/test/a.mjs', ['test/'], false],
    ['testing.mjs', ['test'], false],
  ])('%s vs %j', (path, protectedPaths, expected) => {
    expect(isProtectedPath(path, protectedPaths)).toBe(expected);
  });
});

describe('gradeDetectScripts', () => {
  it('is correct only when the script passes clean AND fails broken', () => {
    const base = { valid: true, proposed: 'npm test' };
    expect(gradeDetectScripts({ ...base, cleanPasses: true, brokenFails: true }).correct).toBe(true);
    expect(gradeDetectScripts({ ...base, cleanPasses: true, brokenFails: false }).correct).toBe(false); // vacuous gate
    expect(gradeDetectScripts({ ...base, cleanPasses: false, brokenFails: true }).correct).toBe(false); // always red
  });

  it('is incorrect when nothing was proposed', () => {
    expect(gradeDetectScripts({ valid: true, proposed: null, cleanPasses: null, brokenFails: null }).correct).toBe(
      false
    );
  });

  it('exact match is secondary and informational', () => {
    const outcome = { valid: true, cleanPasses: true, brokenFails: true, expectedVerifyScript: 'npm test' };
    expect(gradeDetectScripts({ ...outcome, proposed: ' npm test ' })).toMatchObject({
      correct: true,
      exactMatch: true,
    });
    expect(gradeDetectScripts({ ...outcome, proposed: 'node --test' })).toMatchObject({
      correct: true,
      exactMatch: false,
    });
    expect(
      gradeDetectScripts({ valid: true, cleanPasses: true, brokenFails: true, proposed: 'x' }).exactMatch
    ).toBeNull();
  });
});

describe('select-candidate', () => {
  it.each([
    [1, 'ab', 'a'],
    [2, 'ab', 'b'],
    [1, 'ba', 'b'],
    [2, 'ba', 'a'],
    [0, 'ab', 'tie'],
    [3, 'ab', 'none'],
    [undefined, 'ba', 'none'],
  ] as const)('slot %s in order %s picks %s', (slot, order, picked) => {
    expect(pickedCandidate(slot, order)).toBe(picked);
  });

  it('grades the picked candidate against the known winner, per order', () => {
    expect(gradeSelectCandidate({ valid: true, winnerSlot: 1, order: 'ab', winner: 'a' }).correct).toBe(true);
    expect(gradeSelectCandidate({ valid: true, winnerSlot: 1, order: 'ba', winner: 'a' }).correct).toBe(false);
    expect(gradeSelectCandidate({ valid: true, winnerSlot: 2, order: 'ba', winner: 'a' }).correct).toBe(true);
  });

  it('a tie or an invalid verdict is incorrect', () => {
    expect(gradeSelectCandidate({ valid: true, winnerSlot: 0, order: 'ab', winner: 'a' })).toMatchObject({
      correct: false,
      picked: 'tie',
    });
    expect(gradeSelectCandidate({ valid: false, winnerSlot: 1, order: 'ab', winner: 'a' })).toMatchObject({
      correct: false,
      structurallyValid: false,
      picked: 'none',
    });
  });
});
