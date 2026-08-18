import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { entropyCheckLeaf, type EntropyCheckDeps } from '@src/application/flows/implement/leaves/entropy-check.ts';
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

/**
 * These tests exercise the leaf's OWN predicate in isolation, on ctx states hand-fed to
 * `leaf.execute`. Read them alongside the subordination fence below and the composed-loop tests
 * in `tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` — in the real
 * `gen-eval-turn` sequential the evaluator leaf runs two elements earlier on the SAME window, so a
 * window this leaf would fire on has already produced a `source: 'threshold'` exit and the
 * `alreadyExiting` short-circuit wins. The isolated firing cases below are the leaf's contract,
 * NOT a claim that a `source: 'entropy'` exit is reachable through the composed loop.
 */
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

/**
 * SUBORDINATION FENCE — what the composed `gen-eval-turn` sequential actually presents to this
 * leaf. The evaluator leaf runs two elements earlier and merges `computePlateauVerdict`'s exit
 * onto `ctx.lastExit`; this leaf then re-reads the SAME window through `windowIsHardStall`. Both
 * route through `classifyPlateauWindow`, so the two conditions the leaf needs — a hard-stalled
 * window AND `lastExit === undefined` — are mutually exclusive by construction.
 *
 * These tests pin that mutual exclusion at the fixture level, so the day the subordination gate
 * changes (either direction) the fixtures above stop silently describing an unreachable state.
 * The end-to-end counterpart is the "attributes a genuine stall to the calibrated 'threshold'
 * detector" case in `tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts`.
 */
describe('entropyCheckLeaf — subordination to the calibrated predicate', () => {
  const THRESHOLD = 3;

  it('the very window the leaf fires on is one the evaluator already exited as a threshold plateau', () => {
    const window = collapsedWindow(['h1', 'h1', 'h1']);
    const current = window[window.length - 1];
    expect(current).toBeDefined();
    if (current === undefined) return;

    // The leaf's own calibration gate opens …
    expect(windowIsHardStall(window, { threshold: THRESHOLD })).toBe(true);
    // … but only on a window the calibrated predicate — running TWO ELEMENTS EARLIER on the same
    // history — has already ruled a plateau, which the evaluator leaf merges onto ctx.lastExit.
    const verdict = computePlateauVerdict(window.slice(0, -1), current, { threshold: THRESHOLD });
    expect(verdict.kind).toBe('plateau');
  });

  it('is a no-op on the ctx the loop really hands it — the threshold exit survives unre-attributed', async () => {
    const leaf = entropyCheckLeaf(buildDeps({ maxTurns: 10, plateauThreshold: THRESHOLD }), task.id);
    // Exactly what the evaluator leaf leaves behind on a stalled window: history appended AND a
    // calibrated `source: 'threshold'` exit already set. Opted IN, so only the subordination gate
    // can keep the leaf quiet here.
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: THRESHOLD,
      plateauHistory: collapsedWindow(['h1', 'h1', 'h1']),
      lastExit: { kind: 'plateau', dimensions: ['correctness'], source: 'threshold' },
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: ['correctness'], source: 'threshold' });
  });
});
