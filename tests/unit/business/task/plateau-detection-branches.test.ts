/**
 * Supplemental unit tests for plateau-detection.ts — additional edge cases not
 * covered by the main plateau-detection.test.ts file.
 *
 * Focus areas:
 *   - trigramJaccard edge cases: strings shorter than 3 chars, single-char strings
 *   - computePlateauVerdict: empty-string critique (not treated as shifted), whitespace-only
 *     critique (treated as missing), multiple dimensions plateau
 *   - failedDimensions: deduplication of repeated dimension names
 *   - commit-progress exemption requires both prior AND current to have non-empty subjects
 */

import { describe, expect, it } from 'vitest';
import type { DimensionScore, EvaluationSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import {
  computePlateauVerdict,
  failedDimensions,
  trigramJaccard,
  type PlateauTurnRecord,
} from '@src/business/task/plateau-detection.ts';

const NOW = isoTimestamp('2026-05-26T10:00:00.000Z');

const dim = (name: string, passed: boolean): DimensionScore => ({
  dimension: name,
  passed,
  finding: passed ? '' : 'placeholder failure finding',
});

const evalFrom = (...dims: DimensionScore[]): EvaluationSignal => ({
  type: 'evaluation',
  status: dims.every((d) => d.passed) ? 'passed' : 'failed',
  dimensions: dims,
  timestamp: NOW,
});

const turn = (ev: EvaluationSignal, extras?: { critique?: string; commitSubject?: string }): PlateauTurnRecord => ({
  evaluation: ev,
  ...(extras?.critique !== undefined ? { critique: extras.critique } : {}),
  ...(extras?.commitSubject !== undefined ? { commitSubject: extras.commitSubject } : {}),
});

describe('trigramJaccard — short and boundary inputs', () => {
  it('returns 1 for two strings shorter than 3 chars that are identical', () => {
    expect(trigramJaccard('ab', 'ab')).toBe(1);
  });

  it('returns 0 for two short disjoint strings (single chars with no common trigram)', () => {
    // 'x' and 'y' are each < 3 chars; their normalised sets are {'x'} and {'y'} — no overlap
    const result = trigramJaccard('x', 'y');
    expect(result).toBe(0);
  });

  it('returns 1 for two strings that are both single-char and identical', () => {
    expect(trigramJaccard('a', 'a')).toBe(1);
  });

  it('returns a value between 0 and 1 for partially overlapping strings', () => {
    const j = trigramJaccard('hello world', 'hello earth');
    expect(j).toBeGreaterThan(0);
    expect(j).toBeLessThan(1);
  });

  it('is symmetric: J(a,b) === J(b,a)', () => {
    const a = 'quick brown fox';
    const b = 'lazy dog jumps';
    expect(trigramJaccard(a, b)).toBe(trigramJaccard(b, a));
  });
});

describe('failedDimensions — deduplication', () => {
  it('deduplicates dimension names that differ only by case', () => {
    const sig = evalFrom(dim('Correctness', false), dim('correctness', false));
    const failed = failedDimensions(sig);
    // Both normalise to 'correctness' → set size should be 1
    expect(failed.size).toBe(1);
    expect(failed.has('correctness')).toBe(true);
  });

  it('includes only failed dims when mixed passed/failed present', () => {
    const sig = evalFrom(dim('a', false), dim('b', true), dim('c', false), dim('d', true));
    const failed = failedDimensions(sig);
    expect(failed).toStrictEqual(new Set(['a', 'c']));
  });

  it('returns empty set for signal with no dimensions', () => {
    const sig: EvaluationSignal = { type: 'evaluation', status: 'failed', dimensions: [], timestamp: NOW };
    expect(failedDimensions(sig).size).toBe(0);
  });
});

describe('computePlateauVerdict — whitespace/empty critique exemption', () => {
  it('does not exempt when prior critique is whitespace-only (treated as missing)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: '   ' })], // whitespace-only → treated as empty
      turn(ev, { critique: 'a completely different critique with new content here' }),
      { threshold: 2 }
    );
    // Prior critique is whitespace → exemption condition not met → plateau fires
    expect(verdict.kind).toBe('plateau');
  });

  it('does not exempt when current critique is whitespace-only', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: 'the prior critique text with some real content' })],
      turn(ev, { critique: '   ' }), // whitespace-only current
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('does not soften when commit subject is empty string on current side', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'prior subject' })],
      turn(ev, { commitSubject: '' }), // empty → treated as missing
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('does not soften when commit subject is whitespace-only on prior side', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: '   ' })], // whitespace → treated as missing
      turn(ev, { commitSubject: 'new subject' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — multiple dimensions plateau', () => {
  it('fires plateau when multiple dimensions are all repeated across the threshold', () => {
    const ev = evalFrom(dim('correctness', false), dim('completeness', false), dim('safety', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
    if (verdict.kind === 'plateau') {
      expect(verdict.dimensions).toHaveLength(3);
      expect(verdict.dimensions).toContain('correctness');
      expect(verdict.dimensions).toContain('completeness');
      expect(verdict.dimensions).toContain('safety');
    }
  });

  it('does not fire when one dimension drops from the failed set', () => {
    const prior = evalFrom(dim('correctness', false), dim('completeness', false));
    // Current only has correctness failing — the set changed
    const current = evalFrom(dim('correctness', false), dim('completeness', true));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });

  it('does not fire when one new dimension appears in the failed set', () => {
    const prior = evalFrom(dim('correctness', false));
    const current = evalFrom(dim('correctness', false), dim('completeness', false));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });
});

describe('computePlateauVerdict — critique-shift vs commit-progress priority', () => {
  it('critique-shift exemption takes priority over commit-progress (returns progress not warning)', () => {
    // Both critique and commit subject changed. Critique-shift is checked first in the code.
    const ev = evalFrom(dim('completeness', false));
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: priorCritique, commitSubject: 'prior subject' })],
      turn(ev, { critique: currentCritique, commitSubject: 'new subject' }),
      { threshold: 2 }
    );
    // Critique shift fires first → `progress` (not `warning`)
    expect(verdict.kind).toBe('progress');
    if (verdict.kind === 'progress') {
      expect(verdict.reason).toBe('critique-shifted');
    }
  });
});
