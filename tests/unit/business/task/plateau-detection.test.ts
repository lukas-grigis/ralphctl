import { describe, expect, it } from 'vitest';
import type { DimensionScore, EvaluationSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import {
  computePlateauVerdict,
  dimensionsEqual,
  failedDimensions,
  type PlateauTurnRecord,
  trigramJaccard,
} from '@src/business/task/plateau-detection.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const dim = (name: string, passed: boolean, applicable?: boolean): DimensionScore => ({
  dimension: name,
  passed,
  finding: passed ? '' : 'placeholder failure finding',
  ...(applicable !== undefined ? { applicable } : {}),
});

const evalFrom = (...dims: DimensionScore[]): EvaluationSignal => ({
  type: 'evaluation',
  status: dims.every((d) => d.passed) ? 'passed' : 'failed',
  dimensions: dims,
  timestamp: NOW,
});

const turn = (
  ev: EvaluationSignal,
  extras?: {
    critique?: string;
    commitSubject?: string;
    changedFilesHash?: string;
    verdict?: PlateauTurnRecord['verdict'];
  }
): PlateauTurnRecord => ({
  evaluation: ev,
  ...(extras?.critique !== undefined ? { critique: extras.critique } : {}),
  ...(extras?.commitSubject !== undefined ? { commitSubject: extras.commitSubject } : {}),
  ...(extras?.changedFilesHash !== undefined ? { changedFilesHash: extras.changedFilesHash } : {}),
  ...(extras?.verdict !== undefined ? { verdict: extras.verdict } : {}),
});

describe('failedDimensions', () => {
  it('returns empty set when nothing failed', () => {
    expect(failedDimensions(evalFrom(dim('correctness', true)))).toEqual(new Set());
  });

  it('returns lowercased trimmed names of failed dimensions only', () => {
    const sig = evalFrom(dim(' Correctness ', false), dim('Completeness', true), dim('SAFETY', false));
    expect(failedDimensions(sig)).toEqual(new Set(['correctness', 'safety']));
  });

  it('excludes an applicable:false dimension even when passed is false', () => {
    const sig = evalFrom(dim('correctness', false), dim('robustness', false, false));
    expect(failedDimensions(sig)).toEqual(new Set(['correctness']));
  });
});

describe('dimensionsEqual', () => {
  it("false when both sets empty (no failures couldn't have caused a plateau)", () => {
    expect(dimensionsEqual(evalFrom(dim('a', true)), evalFrom(dim('a', true)))).toBe(false);
  });

  it('false when one side empty', () => {
    const failed = evalFrom(dim('a', false));
    const passed = evalFrom(dim('a', true));
    expect(dimensionsEqual(failed, passed)).toBe(false);
    expect(dimensionsEqual(passed, failed)).toBe(false);
  });

  it('false when sets are disjoint', () => {
    expect(dimensionsEqual(evalFrom(dim('a', false)), evalFrom(dim('b', false)))).toBe(false);
  });

  it('false when sets are not equal in size', () => {
    expect(dimensionsEqual(evalFrom(dim('a', false)), evalFrom(dim('a', false), dim('b', false)))).toBe(false);
  });

  it('true when sets match exactly', () => {
    expect(
      dimensionsEqual(evalFrom(dim('a', false), dim('b', false)), evalFrom(dim('a', false), dim('b', false)))
    ).toBe(true);
  });

  it('case-insensitive and whitespace-insensitive comparison', () => {
    expect(dimensionsEqual(evalFrom(dim('Correctness', false)), evalFrom(dim(' correctness ', false)))).toBe(true);
  });
});

describe('trigramJaccard', () => {
  it('returns 1 for identical strings', () => {
    expect(trigramJaccard('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(trigramJaccard('', '')).toBe(1);
  });

  it('returns a small value for disjoint strings', () => {
    expect(trigramJaccard('alpha beta gamma', 'XYZ QRS TUV')).toBeLessThan(0.1);
  });

  it('produces ≥ 0.5 for tiny tweaks', () => {
    const a = 'still missing the early-return branch in the parser';
    const b = 'still missing the early-return branch in the parser.';
    expect(trigramJaccard(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it('produces < 0.5 for materially different prose', () => {
    const a = 'still missing the early-return branch in the parser';
    const b = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    expect(trigramJaccard(a, b)).toBeLessThan(0.5);
  });
});

describe('computePlateauVerdict — base case (regression for 2026-05-20 verified path)', () => {
  it('fires when dimensions repeat identically across the default threshold of 2 turns', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
    if (verdict.kind === 'plateau') expect(verdict.dimensions).toEqual(['completeness']);
  });

  it('does not fire on a single turn (not enough history)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([], turn(ev), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });

  it('does not fire when current turn has no failed dimensions', () => {
    const prior = evalFrom(dim('completeness', false));
    const current = evalFrom(dim('completeness', true));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });
});

describe('computePlateauVerdict — net-progress predicate (gap i: oscillating dimensions)', () => {
  it('fires on a flip-flop at the same failure count (gap i: shifting members never used to plateau)', () => {
    // {correctness} → {completeness}: both count 1. The old identical-set check returned `none`
    // and let the loop run to the budget; the count predicate treats a same-count flip-flop as a stall.
    const prior = evalFrom(dim('correctness', false));
    const current = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
  });

  it('fires when the failure count grows across the window (regressing, not progressing)', () => {
    const prior = evalFrom(dim('correctness', false));
    const current = evalFrom(dim('correctness', false), dim('safety', false));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
  });

  it('does NOT fire when the failure count drops — a shrinking failed set is real progress', () => {
    const prior = evalFrom(dim('correctness', false), dim('safety', false));
    const current = evalFrom(dim('correctness', false), dim('safety', true));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });

  it('threshold=3: count drop anywhere in the window breaks the stall', () => {
    const two = evalFrom(dim('correctness', false), dim('safety', false));
    const one = evalFrom(dim('correctness', false));
    // window: [two, one] + current(two): 2 → 1 is a drop → no stall.
    const verdict = computePlateauVerdict([turn(two), turn(one)], turn(two), { threshold: 3 });
    expect(verdict.kind).toBe('none');
  });

  it('threshold=3: oscillating members at a constant count plateaus once the window fills', () => {
    const a = evalFrom(dim('correctness', false), dim('safety', false));
    const b = evalFrom(dim('safety', false), dim('consistency', false));
    const c = evalFrom(dim('consistency', false), dim('correctness', false));
    // All count 2 with shifting members → stall.
    const verdict = computePlateauVerdict([turn(a), turn(b)], turn(c), { threshold: 3 });
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — work-product softening (gap iii: fingerprint, not text)', () => {
  it('returns "warning" when the work-product fingerprint changed between turns', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { changedFilesHash: 'hash-A' })],
      turn(ev, { changedFilesHash: 'hash-B' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('warning');
    if (verdict.kind === 'warning') {
      expect(verdict.dimensions).toEqual(['completeness']);
      expect(verdict.reason).toBe('work-product-changed');
    }
  });

  it('does NOT soften when the fingerprint is identical even if the commit subject was reworded', () => {
    // gap iii: an LLM rewording the subject over an unchanged tree must not evade the plateau.
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { changedFilesHash: 'same-hash', commitSubject: 'WIP option A' })],
      turn(ev, { changedFilesHash: 'same-hash', commitSubject: 'WIP option B (reworded)' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('falls back to the commit-subject proxy only when no fingerprint is present', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'WIP option A' })],
      turn(ev, { commitSubject: 'WIP option B' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('warning');
    if (verdict.kind === 'warning') expect(verdict.reason).toBe('work-product-changed');
  });

  it('either-side rule: current hash MISSING while priors carry hashes → no exemption (a reworded subject must not soften on a git hiccup)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { changedFilesHash: 'hash-A', commitSubject: 'WIP option A' })],
      // Transient git failure on the current round: no fingerprint, only a reworded subject.
      turn(ev, { commitSubject: 'WIP option B (reworded)' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('either-side rule: current hash present but NO prior hashes → conservative no-exemption', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'WIP option A' })],
      turn(ev, { changedFilesHash: 'hash-B', commitSubject: 'WIP option A' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('does not soften when neither fingerprint nor commit subject changed', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'same subject' })],
      turn(ev, { commitSubject: 'same subject' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('caps consecutive warning softenings (gap: unbounded warnings churned to the budget)', () => {
    const ev = evalFrom(dim('completeness', false));
    // Two prior turns already softened to `warning` (stamped on the records). A third fingerprint
    // change must NOT keep softening — the warning cap fires the plateau.
    const priorTurns = [
      turn(ev, { changedFilesHash: 'hash-1', verdict: 'warning' }),
      turn(ev, { changedFilesHash: 'hash-2', verdict: 'warning' }),
    ];
    const verdict = computePlateauVerdict(priorTurns, turn(ev, { changedFilesHash: 'hash-3' }), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
  });

  it('still softens at the cap boundary — one prior warning leaves a grace round', () => {
    const ev = evalFrom(dim('completeness', false));
    const priorTurns = [turn(ev, { changedFilesHash: 'hash-1', verdict: 'warning' })];
    const verdict = computePlateauVerdict(priorTurns, turn(ev, { changedFilesHash: 'hash-2' }), { threshold: 2 });
    expect(verdict.kind).toBe('warning');
  });
});

describe('computePlateauVerdict — critique-shift exemption', () => {
  it('returns "progress" when critique Jaccard < 0.5', () => {
    const ev = evalFrom(dim('completeness', false));
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: priorCritique })],
      turn(ev, { critique: currentCritique }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('progress');
    if (verdict.kind === 'progress') expect(verdict.reason).toBe('critique-shifted');
  });

  it('does not exempt when critique is near-identical (Jaccard ≥ 0.5)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: 'still missing the X branch' })],
      turn(ev, { critique: 'still missing the X branch.' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('falls through to plateau when critique is missing on either side', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev, { critique: 'only one side has it' }), {
      threshold: 2,
    });
    expect(verdict.kind).toBe('plateau');
  });

  it('compares against the MAX similarity over ALL prior turns, defeating A/B/A alternation (gap ii)', () => {
    // critiqueA → critiqueB → critiqueA. The current (A) looks novel next to its neighbour (B),
    // but it recycles the window's FIRST turn (A). Comparing against all priors catches the recycle.
    const ev = evalFrom(dim('completeness', false));
    const critiqueA = 'still missing the early-return branch in the parser';
    const critiqueB = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: critiqueA }), turn(ev, { critique: critiqueB })],
      turn(ev, { critique: critiqueA }),
      { threshold: 3 }
    );
    // The most-recent-prior comparison (B vs A) would have looked like a shift → `progress`; the
    // all-priors max (A vs A = 1.0) correctly recognises the recycled complaint → plateau.
    expect(verdict.kind).toBe('plateau');
  });

  it('still exempts genuinely-novel critique versus every prior turn (gap ii control)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [
        turn(ev, { critique: 'still missing the early-return branch in the parser' }),
        turn(ev, { critique: 'race condition in the connection pool on shutdown' }),
      ],
      turn(ev, { critique: 'memory leak: the file watcher is never unsubscribed on teardown' }),
      { threshold: 3 }
    );
    expect(verdict.kind).toBe('progress');
  });
});

describe('computePlateauVerdict — configurable threshold', () => {
  it('threshold=3: two consecutive same-dim turns → no plateau yet', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 3 });
    expect(verdict.kind).toBe('none');
  });

  it('threshold=3: three consecutive same-dim turns → plateau fires', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev), turn(ev)], turn(ev), { threshold: 3 });
    expect(verdict.kind).toBe('plateau');
  });

  it('threshold=5: needs 5 consecutive same-dim turns; 4 prior + current fires', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev), turn(ev), turn(ev), turn(ev)], turn(ev), { threshold: 5 });
    expect(verdict.kind).toBe('plateau');
  });

  it('clamps an out-of-range threshold defensively (0 → 2)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 0 });
    expect(verdict.kind).toBe('plateau');
  });

  it('clamps an out-of-range threshold defensively (99 → 5)', () => {
    const ev = evalFrom(dim('completeness', false));
    // Four prior + current = 5 turns total — exactly the clamped maximum.
    const verdict = computePlateauVerdict([turn(ev), turn(ev), turn(ev), turn(ev)], turn(ev), {
      threshold: 99,
    });
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — workProductChanged "differs from EVERY prior" multi-window (D3)', () => {
  // D3: workProductChanged is documented as "differs from EVERY prior turn in the window".
  // The current implementation iterates from the last hashed prior and returns at the FIRST
  // match — it only compares against the LAST hashed prior, not ALL of them.
  // The test below exposes the gap: current hash equals an EARLIER prior but differs from the
  // LAST prior. The exemption should NOT fire (plateau), but the current code returns 'warning'
  // because it only checks the last one.
  // NOTE: if the implementation is fixed to check all priors, this test will pass naturally.
  // If the implementation has the gap, this test will FAIL and surface the bug.
  it('at threshold=3, current hash matches an EARLIER prior but differs from the LAST → NO exemption, plateau fires', async () => {
    // window = [hash-A (turn 0), hash-B (turn 1)], current = hash-A.
    // "differs from every prior" requires hash-A !== hash-A (turn 0) which is FALSE →
    // the exemption must NOT be granted. The plateau must fire.
    // A last-prior-only check would see hash-B !== hash-A → true and grant the exemption
    // (returning 'warning'), which is the bug this test catches.
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [
        turn(ev, { changedFilesHash: 'hash-A' }), // older prior — matches current
        turn(ev, { changedFilesHash: 'hash-B' }), // most-recent prior — differs from current
      ],
      turn(ev, { changedFilesHash: 'hash-A' }), // current equals the OLDER prior
      { threshold: 3 }
    );
    // The work-product exemption requires the hash to differ from EVERY prior in the window.
    // hash-A === hash-A in the window → exemption must NOT apply.
    expect(verdict.kind).toBe('plateau');
  });

  it('at threshold=3, current hash differs from BOTH priors → exemption fires (warning)', async () => {
    // Control: when the hash genuinely differs from every prior, the softening must still work.
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { changedFilesHash: 'hash-A' }), turn(ev, { changedFilesHash: 'hash-B' })],
      turn(ev, { changedFilesHash: 'hash-C' }),
      { threshold: 3 }
    );
    expect(verdict.kind).toBe('warning');
    if (verdict.kind === 'warning') expect(verdict.reason).toBe('work-product-changed');
  });

  it('at threshold=3, current hash matches the LAST prior — plateau fires regardless of earlier prior hashes', async () => {
    // If current === last prior, the exemption must not apply even though an earlier prior differs.
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [
        turn(ev, { changedFilesHash: 'hash-X' }), // older prior — differs from current
        turn(ev, { changedFilesHash: 'hash-Y' }), // last prior — matches current
      ],
      turn(ev, { changedFilesHash: 'hash-Y' }), // current equals the LAST prior
      { threshold: 3 }
    );
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — sliding window', () => {
  it('only looks at the most-recent (threshold-1) prior turns, not the whole history', () => {
    const stable = evalFrom(dim('completeness', false));
    const noise = evalFrom(dim('safety', false));
    // Old noise should not break the window: at threshold=2 we only compare the last prior + current.
    const verdict = computePlateauVerdict([turn(noise), turn(stable)], turn(stable), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
  });
});
