import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import {
  loopDiversityCheckLeaf,
  type LoopDiversityCheckDeps,
} from '@src/application/flows/implement/leaves/loop-diversity-check.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';

const task = makeInProgressTaskWithRunningAttempt();

const baseCtx = (): ImplementCtx => ({
  sprintId: task.id as unknown as ImplementCtx['sprintId'],
});

const buildDeps = (maxTurns: number): LoopDiversityCheckDeps => ({
  readConfig: async () => ({ maxTurns }),
  eventBus: createInMemoryEventBus(),
  clock: () => FIXED_NOW,
});

/** One evaluator-turn record with the given failed dimension (a single-element fingerprint). */
const recordFor = (failingDimension: string): PlateauTurnRecord => {
  const evaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions: [{ dimension: failingDimension, passed: false, finding: 'nope' }],
    timestamp: FIXED_NOW,
  };
  return { evaluation };
};

describe('loopDiversityCheckLeaf', () => {
  it('sets a diversity plateau exit when the last 3 records share the identical failed-dimension fingerprint', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [recordFor('correctness'), recordFor('correctness'), recordFor('correctness')],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: ['correctness'], source: 'diversity' });
  });

  it('leaves lastExit undefined when the last 3 records carry differing fingerprints', async () => {
    const leaf = loopDiversityCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [recordFor('correctness'), recordFor('completeness'), recordFor('safety')],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when turnsUsed >= maxTurns — budget precedence suppresses the plateau exit', async () => {
    // Same repeated-fingerprint window as the positive case, but the turn budget is already spent.
    const leaf = loopDiversityCheckLeaf(buildDeps(3), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [recordFor('correctness'), recordFor('correctness'), recordFor('correctness')],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });
});
