import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import {
  loopDiversityCheckLeaf,
  type LoopDiversityCheckDeps,
} from '@src/application/flows/implement/leaves/loop-diversity-check.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  computePlateauVerdict,
  windowIsHardStall,
  type PlateauTurnRecord,
} from '@src/business/task/plateau-detection.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';

const task = makeInProgressTaskWithRunningAttempt();

const baseCtx = (): ImplementCtx => ({
  sprintId: task.id as unknown as ImplementCtx['sprintId'],
});

const buildDeps = (maxTurns: number, plateauThreshold = 3): LoopDiversityCheckDeps => ({
  readConfig: async () => ({ maxTurns }),
  eventBus: createInMemoryEventBus(),
  clock: () => FIXED_NOW,
  plateauThreshold,
});

const RECYCLED = 'the parser still mishandles the trailing comma case in the tokenizer module';
const SHIFTED = 'timezone conversion drops the daylight-saving offset on southern-hemisphere dates';

/** One evaluator-turn record with the given failed dimension (a single-element fingerprint). */
const recordFor = (
  failingDimension: string,
  opts: { readonly critique?: string; readonly hash?: string } = {}
): PlateauTurnRecord => {
  const evaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions: [{ dimension: failingDimension, passed: false, finding: 'nope' }],
    timestamp: FIXED_NOW,
  };
  return {
    evaluation,
    ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
    ...(opts.hash !== undefined ? { changedFilesHash: opts.hash } : {}),
  };
};

/** `n` turns that all failed `correctness` with the same critique and the same working tree. */
const stalledWindow = (n: number): readonly PlateauTurnRecord[] =>
  Array.from({ length: n }, () => recordFor('correctness', { critique: RECYCLED, hash: 'h1' }));

/**
 * These tests exercise the leaf's OWN predicate in isolation, on ctx states hand-fed to
 * `leaf.execute`. Read them alongside the subordination fence below and the composed-loop tests
 * in `tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` — in the real
 * `gen-eval-turn` sequential the evaluator leaf runs one element earlier on the SAME window, so a
 * window this leaf would fire on has already produced a `source: 'threshold'` exit and the
 * `alreadyExiting` short-circuit wins. The isolated firing cases below are the leaf's contract,
 * NOT a claim that a `source: 'diversity'` exit is reachable through the composed loop.
 */
describe('loopDiversityCheckLeaf', () => {
  it('sets a diversity plateau exit when the window repeats an identical fingerprint over an unchanged tree', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = { ...baseCtx(), genEvalTurn: 3, plateauHistory: stalledWindow(3) };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: ['correctness'], source: 'diversity' });
  });

  it('leaves lastExit undefined when the records carry differing fingerprints', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        recordFor('correctness', { critique: RECYCLED, hash: 'h1' }),
        recordFor('completeness', { critique: RECYCLED, hash: 'h1' }),
        recordFor('safety', { critique: RECYCLED, hash: 'h1' }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  /**
   * The calibrated predicate's work-product exemption: the AI edited the tree every round, so the
   * repeated failure fingerprint is not (yet) a stall. The detector must honour the same exemption
   * rather than pre-empting it with its own fingerprint-only verdict.
   */
  it('leaves lastExit undefined when the work product changed every turn', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        recordFor('correctness', { critique: RECYCLED, hash: 'h1' }),
        recordFor('correctness', { critique: RECYCLED, hash: 'h2' }),
        recordFor('correctness', { critique: RECYCLED, hash: 'h3' }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when the critique shifted across the window', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        recordFor('correctness', { critique: RECYCLED, hash: 'h1' }),
        recordFor('correctness', { critique: RECYCLED, hash: 'h1' }),
        recordFor('correctness', { critique: SHIFTED, hash: 'h1' }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('windows from the operator threshold instead of a hardcoded 3', async () => {
    const patient = loopDiversityCheckLeaf(buildDeps(10, 5), task.id);
    const eager = loopDiversityCheckLeaf(buildDeps(10, 2), task.id);

    const threeTurns: ImplementCtx = { ...baseCtx(), genEvalTurn: 3, plateauHistory: stalledWindow(3) };
    const fiveTurns: ImplementCtx = { ...baseCtx(), genEvalTurn: 5, plateauHistory: stalledWindow(5) };
    const twoTurns: ImplementCtx = { ...baseCtx(), genEvalTurn: 2, plateauHistory: stalledWindow(2) };

    const patientShort = await patient.execute(threeTurns);
    const patientFull = await patient.execute(fiveTurns);
    const eagerFull = await eager.execute(twoTurns);

    expect(patientShort.ok && patientShort.value.ctx.lastExit).toBeUndefined();
    expect(patientFull.ok && patientFull.value.ctx.lastExit).toEqual({
      kind: 'plateau',
      dimensions: ['correctness'],
      source: 'diversity',
    });
    expect(eagerFull.ok && eagerFull.value.ctx.lastExit).toEqual({
      kind: 'plateau',
      dimensions: ['correctness'],
      source: 'diversity',
    });
  });

  it('leaves lastExit undefined when turnsUsed >= maxTurns — budget precedence suppresses the plateau exit', async () => {
    // Same stalled window as the positive case, but the turn budget is already spent.
    const leaf = loopDiversityCheckLeaf(buildDeps(3), task.id);
    const ctx: ImplementCtx = { ...baseCtx(), genEvalTurn: 3, plateauHistory: stalledWindow(3) };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });
});

/**
 * SUBORDINATION FENCE — what the composed `gen-eval-turn` sequential actually presents to this
 * leaf. The evaluator leaf runs one element earlier and merges `computePlateauVerdict`'s exit onto
 * `ctx.lastExit`; this leaf then re-reads the SAME window through `windowIsHardStall`. Both route
 * through `classifyPlateauWindow`, so the two conditions the leaf needs — a hard-stalled window
 * AND `lastExit === undefined` — are mutually exclusive by construction.
 *
 * These tests pin that mutual exclusion at the fixture level, so the day the subordination gate
 * changes (either direction) the fixtures above stop silently describing an unreachable state.
 * The end-to-end counterpart is the "attributes a genuine stall to the calibrated 'threshold'
 * detector" case in `tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts`.
 */
describe('loopDiversityCheckLeaf — subordination to the calibrated predicate', () => {
  const THRESHOLD = 3;

  it('the very window the leaf fires on is one the evaluator already exited as a threshold plateau', () => {
    const window = stalledWindow(THRESHOLD);
    const current = window[window.length - 1];
    expect(current).toBeDefined();
    if (current === undefined) return;

    // The leaf's own gate opens …
    expect(windowIsHardStall(window, { threshold: THRESHOLD })).toBe(true);
    // … but only on a window the calibrated predicate — running ONE ELEMENT EARLIER on the same
    // history — has already ruled a plateau, which the evaluator leaf merges onto ctx.lastExit.
    const verdict = computePlateauVerdict(window.slice(0, -1), current, { threshold: THRESHOLD });
    expect(verdict.kind).toBe('plateau');
  });

  it('is a no-op on the ctx the loop really hands it — the threshold exit survives unre-attributed', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10, THRESHOLD), task.id);
    // Exactly what the evaluator leaf leaves behind on a stalled window: history appended AND a
    // calibrated `source: 'threshold'` exit already set.
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: THRESHOLD,
      plateauHistory: stalledWindow(THRESHOLD),
      lastExit: { kind: 'plateau', dimensions: ['correctness'], source: 'threshold' },
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: ['correctness'], source: 'threshold' });
  });
});
