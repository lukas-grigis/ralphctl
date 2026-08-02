import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { entropyCheckLeaf, type EntropyCheckDeps } from '@src/application/flows/implement/leaves/entropy-check.ts';
import { DIVERSITY_WINDOW_SIZE } from '@src/application/flows/implement/leaves/loop-diversity-check.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const task = makeInProgressTaskWithRunningAttempt();

const baseCtx = (): ImplementCtx => ({
  sprintId: task.id as unknown as ImplementCtx['sprintId'],
});

const buildDeps = (maxTurns: number): EntropyCheckDeps => ({
  readConfig: async () => ({ maxTurns }),
  eventBus: createInMemoryEventBus(),
  clock: () => FIXED_NOW,
});

describe('entropyCheckLeaf', () => {
  it('sets a plateau exit sourced from entropy when the turn action counts collapse to a single kind', async () => {
    const leaf = entropyCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: DIVERSITY_WINDOW_SIZE,
      lastTurnActionCounts: new Map([['note', 4]]),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toEqual({ kind: 'plateau', dimensions: [], source: 'entropy' });
  });

  it('leaves lastExit undefined when turnsUsed is below DIVERSITY_WINDOW_SIZE — the gate suppresses the check', async () => {
    const leaf = entropyCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: DIVERSITY_WINDOW_SIZE - 1,
      lastTurnActionCounts: new Map([['note', 4]]),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });

  it('leaves lastExit undefined when the action-kind distribution is diverse (high entropy)', async () => {
    const leaf = entropyCheckLeaf(buildDeps(10), task.id);
    const ctx: ImplementCtx = {
      ...baseCtx(),
      genEvalTurn: DIVERSITY_WINDOW_SIZE,
      lastTurnActionCounts: new Map([
        ['decision', 1],
        ['change', 1],
        ['learning', 1],
        ['note', 1],
      ]),
    };

    const out = await leaf.execute(ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.ctx.lastExit).toBeUndefined();
  });
});
