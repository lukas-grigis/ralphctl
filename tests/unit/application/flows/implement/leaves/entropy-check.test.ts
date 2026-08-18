import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { entropyCheckLeaf, type EntropyCheckDeps } from '@src/application/flows/implement/leaves/entropy-check.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';

const task = makeInProgressTaskWithRunningAttempt();

const baseCtx = (): ImplementCtx => ({
  sprintId: task.id as unknown as ImplementCtx['sprintId'],
});

const buildDeps = (opts: {
  readonly maxTurns: number;
  readonly plateauThreshold?: number;
  readonly enabled?: boolean;
}): EntropyCheckDeps => ({
  readConfig: async () => ({ maxTurns: opts.maxTurns }),
  eventBus: createInMemoryEventBus(),
  clock: () => FIXED_NOW,
  plateauThreshold: opts.plateauThreshold ?? 3,
  enabled: opts.enabled ?? true,
});

const RECYCLED = 'the parser still mishandles the trailing comma case in the tokenizer module';
const SHIFTED = 'timezone conversion drops the daylight-saving offset on southern-hemisphere dates';

const evaluationFor = (dimensions: readonly string[]): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  dimensions: dimensions.map((d) => ({ dimension: d, passed: false, finding: 'nope' })),
  timestamp: FIXED_NOW,
});

const rec = (opts: {
  readonly critique?: string;
  readonly hash?: string;
  readonly actionCounts?: ReadonlyMap<string, number>;
}): PlateauTurnRecord => ({
  evaluation: evaluationFor(['correctness']),
  critique: opts.critique ?? RECYCLED,
  ...(opts.hash !== undefined ? { changedFilesHash: opts.hash } : {}),
  ...(opts.actionCounts !== undefined ? { actionCounts: opts.actionCounts } : {}),
});

/** Three turns that emitted ONLY `change` signals — pooled K=1 → H=0. */
const collapsedWindow = (hashes: readonly string[]): readonly PlateauTurnRecord[] =>
  hashes.map((hash) => rec({ hash, actionCounts: new Map([['change', 3]]) }));

describe('entropyCheckLeaf', () => {
  /**
   * REGRESSION — the K=1 false positive. Before windowing, a SINGLE turn that emitted only one
   * signal kind scored H=0 and exited the loop with a plateau, burning an escalation rung plus a
   * whole attempt even while the AI was visibly editing the tree every round. The detector now
   * refuses to speak on a window whose work-product fingerprint moved.
   */
  it('does NOT exit when the work product changed every turn, even on a fully collapsed distribution', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: collapsedWindow(['h1', 'h2', 'h3']),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('does NOT exit when the critique shifted across the window, even on a collapsed distribution', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        rec({ hash: 'h1', actionCounts: new Map([['change', 3]]) }),
        rec({ hash: 'h1', actionCounts: new Map([['change', 3]]) }),
        rec({ hash: 'h1', critique: SHIFTED, actionCounts: new Map([['change', 3]]) }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('sets an entropy-sourced plateau exit on a hard-stalled window whose pooled distribution collapsed', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1']),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: [], source: 'entropy' });
  });

  it('never exits when the detector is disabled — the shipped default', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10, enabled: false }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1']),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('waits for a full window — the operator threshold, not a turn counter, gates the check', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10, plateauThreshold: 5 }), task.id);
    const short: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 4,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1', 'h1']),
    };
    const full: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 5,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1', 'h1', 'h1']),
    };

    const shortOut = await leaf.execute(short);
    const fullOut = await leaf.execute(full);

    expect(shortOut.ok && shortOut.value.ctx.lastExit).toBeUndefined();
    expect(fullOut.ok && fullOut.value.ctx.lastExit).toEqual({
      kind: 'plateau',
      dimensions: [],
      source: 'entropy',
    });
  });

  it('leaves lastExit undefined when a record in the window carries no signal-kind distribution', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        rec({ hash: 'h1', actionCounts: new Map([['change', 3]]) }),
        rec({ hash: 'h1' }),
        rec({ hash: 'h1', actionCounts: new Map([['change', 3]]) }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when the pooled distribution is diverse (high entropy)', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: [
        rec({ hash: 'h1', actionCounts: new Map([['change', 3]]) }),
        rec({ hash: 'h1', actionCounts: new Map([['note', 3]]) }),
        rec({ hash: 'h1', actionCounts: new Map([['decision', 3]]) }),
      ],
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when the turn budget is already spent — budget precedence', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 3 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1']),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when the evaluator already set a terminal exit this turn', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10 }), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: 3,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1']),
      lastExit: { kind: 'passed' },
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'passed' });
  });
});
