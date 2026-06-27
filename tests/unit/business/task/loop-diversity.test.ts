import { describe, expect, it } from 'vitest';
import { createLoopDiversityTracker } from '@src/business/task/loop-diversity.ts';

describe('createLoopDiversityTracker', () => {
  it('reports diverse when there is insufficient history (fewer than windowSize entries)', () => {
    const tracker = createLoopDiversityTracker(3);
    expect(tracker.isDiverse()).toBe(true); // empty
    tracker.record('a');
    expect(tracker.isDiverse()).toBe(true); // 1 < 3
    tracker.record('a');
    expect(tracker.isDiverse()).toBe(true); // 2 < 3
  });

  it('reports NOT diverse when the last windowSize fingerprints are all identical', () => {
    const tracker = createLoopDiversityTracker(3);
    tracker.record('x');
    tracker.record('x');
    tracker.record('x');
    expect(tracker.isDiverse()).toBe(false);
  });

  it('reports diverse when the tail differs even though some history repeats', () => {
    const tracker = createLoopDiversityTracker(3);
    tracker.record('a');
    tracker.record('a');
    tracker.record('b'); // tail [a, a, b] — not all identical
    expect(tracker.isDiverse()).toBe(true);
  });

  it('flips back to NOT diverse once the tail collapses again after a diverse turn', () => {
    const tracker = createLoopDiversityTracker(3);
    tracker.record('a');
    tracker.record('b');
    tracker.record('a');
    expect(tracker.isDiverse()).toBe(true); // [a, b, a]
    tracker.record('a');
    tracker.record('a'); // tail now [a, a, a]
    expect(tracker.isDiverse()).toBe(false);
  });

  it('bounds the internal buffer to windowSize * 2 without affecting the predicate', () => {
    const tracker = createLoopDiversityTracker(2);
    // Push far more than the cap (windowSize*2 = 4); only the recent tail can matter.
    for (let i = 0; i < 50; i += 1) tracker.record(`f-${String(i)}`);
    // All distinct → diverse.
    expect(tracker.isDiverse()).toBe(true);
    // Now collapse the tail.
    tracker.record('same');
    tracker.record('same');
    expect(tracker.isDiverse()).toBe(false);
  });

  it('clamps a windowSize below 2 up to 2 (a window of 1 would fire after every turn)', () => {
    const tracker = createLoopDiversityTracker(1);
    tracker.record('only');
    // With an effective window of 2, a single entry is still insufficient history → diverse.
    expect(tracker.isDiverse()).toBe(true);
    tracker.record('only');
    expect(tracker.isDiverse()).toBe(false);
  });

  it('defaults to a window of 3 when no size is given', () => {
    const tracker = createLoopDiversityTracker();
    tracker.record('z');
    tracker.record('z');
    expect(tracker.isDiverse()).toBe(true); // 2 < 3
    tracker.record('z');
    expect(tracker.isDiverse()).toBe(false); // 3 identical
  });

  it('a fresh tracker starts with no history (independent instances do not share state)', () => {
    const first = createLoopDiversityTracker(2);
    first.record('a');
    first.record('a');
    expect(first.isDiverse()).toBe(false);

    const second = createLoopDiversityTracker(2);
    expect(second.isDiverse()).toBe(true); // fresh — empty buffer
    second.record('b');
    expect(second.isDiverse()).toBe(true); // 1 < 2
  });
});
