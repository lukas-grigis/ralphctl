/**
 * Unit tests for the `finalize-gen-eval` chain leaf — the ctx-projection half of
 * `finalizeGenEvalUseCase` (business logic already covered end-to-end by
 * `tests/unit/business/task/finalize-gen-eval.test.ts`). These tests focus on:
 *  - the leaf's `input`/`output` ctx projection (fails the trace on a pre-finalize invariant
 *    violation, resolves the per-attempt generator/evaluator model+effort the same way the
 *    leaf's own JSDoc documents),
 *  - the `readConfig` threading, specifically the new `bestOfNCandidates` field reaching the
 *    escalation policy and the resulting task stamp landing on `ctx.currentTask`.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  finalizeGenEvalLeaf,
  type FinalizeGenEvalLeafDeps,
} from '@src/application/flows/implement/leaves/finalize-gen-eval.ts';

const fixedClock = (): IsoTimestamp => '2026-08-04T00:00:00.000Z' as IsoTimestamp;

const sprintId = ((): ImplementCtx['sprintId'] => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const okRepo: UpdateTask = {
  async update() {
    return Result.ok(undefined);
  },
};

const nudgedAtTopOn = (task: InProgressTask, model: string): InProgressTask => {
  const stamped = recordTaskEscalation(task, model, model);
  if (!stamped.ok) throw stamped.error;
  return stamped.value;
};

const baseCtx = (task: InProgressTask, overrides?: Partial<ImplementCtx>): ImplementCtx => ({
  sprintId,
  currentTask: task,
  currentTaskId: task.id,
  tasks: [task],
  ...overrides,
});

const baseDeps = (
  readConfig: FinalizeGenEvalLeafDeps['readConfig'],
  overrides?: Partial<FinalizeGenEvalLeafDeps>
): FinalizeGenEvalLeafDeps => ({
  taskRepo: okRepo,
  readConfig,
  logger: noopLogger,
  eventBus: createInMemoryEventBus(),
  clock: fixedClock,
  configuredGeneratorModel: 'claude-opus-5',
  ...overrides,
});

describe('finalizeGenEvalLeaf — ctx projection', () => {
  it('fails when ctx.currentTask is missing (pre-finalize invariant)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = finalizeGenEvalLeaf(
      baseDeps(async () => ({ maxTurns: 5, escalateOnPlateau: false, escalationMap: {}, maxAttempts: 3 })),
      task.id
    );
    const out = await leaf.execute({ sprintId, tasks: [] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error.message).toMatch(/ctx.currentTask missing/);
  });

  it('fails when ctx.currentTask.id does not match the leaf-bound taskId', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const other = makeInProgressTaskWithRunningAttempt();
    const leaf = finalizeGenEvalLeaf(
      baseDeps(async () => ({ maxTurns: 5, escalateOnPlateau: false, escalationMap: {}, maxAttempts: 3 })),
      task.id
    );
    const out = await leaf.execute(baseCtx(other));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error.message).toMatch(/ctx.currentTask missing or mismatched/);
  });

  it('a passed exit projects verdict + terminal task onto ctx, with no shouldFailAttempt', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = finalizeGenEvalLeaf(
      baseDeps(async () => ({ maxTurns: 5, escalateOnPlateau: false, escalationMap: {}, maxAttempts: 3 })),
      task.id
    );
    const out = await leaf.execute(baseCtx(task, { lastExit: { kind: 'passed' } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ctx = out.value.ctx;
    expect(ctx.lastVerdict).toBe('passed');
    expect(ctx.lastShouldFailAttempt).toBeUndefined();
    expect(ctx.currentTask?.id).toBe(task.id);
    expect(ctx.tasks?.some((t) => t.id === task.id)).toBe(true);
  });

  it('resolves generatorModel from task.escalatedToModel over the configured default, and stamps the result back onto ctx', async () => {
    const task = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const leaf = finalizeGenEvalLeaf(
      baseDeps(async () => ({ maxTurns: 5, escalateOnPlateau: true, escalationMap: {}, maxAttempts: 5 }), {
        configuredGeneratorModel: 'claude-sonnet-4-6', // overridden by task.escalatedToModel below
      }),
      task.id
    );
    const out = await leaf.execute(
      baseCtx(task, { lastExit: { kind: 'plateau', dimensions: ['correctness'] }, genEvalTurn: 3 })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ctx = out.value.ctx;
    // nudged-at-top plateau with no best-of-N knob → tops out, done-with-warning.
    expect(ctx.lastVerdict).toBe('failed');
    expect(ctx.lastShouldFailAttempt).toBeUndefined();
    expect(ctx.currentTask).toMatchObject({ escalatedFromModel: 'claude-opus-5', escalatedToModel: 'claude-opus-5' });
  });

  it('threads readConfig().bestOfNCandidates through to the policy — a nudged-at-top plateau grants best-of-N and the grant lands on ctx.currentTask', async () => {
    const task = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const leaf = finalizeGenEvalLeaf(
      baseDeps(
        async () => ({
          maxTurns: 5,
          escalateOnPlateau: true,
          escalationMap: {},
          maxAttempts: 5,
          bestOfNCandidates: 3,
        }),
        { configuredGeneratorModel: 'claude-opus-5' }
      ),
      task.id
    );
    const out = await leaf.execute(
      baseCtx(task, { lastExit: { kind: 'plateau', dimensions: ['correctness'] }, genEvalTurn: 3 })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ctx = out.value.ctx;
    expect(ctx.lastShouldFailAttempt).toBe(true);
    expect(ctx.currentTask).toMatchObject({ bestOfNGranted: true, bestOfNGrantedCandidates: 3 });
    // tasks array carries the same stamped task, keyed by id.
    const projected = ctx.tasks?.find((t) => t.id === task.id);
    expect(projected).toMatchObject({ bestOfNGranted: true, bestOfNGrantedCandidates: 3 });
  });

  it('omitting bestOfNCandidates from readConfig() behaves exactly like 0 — tops out, no grant', async () => {
    const task = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const leaf = finalizeGenEvalLeaf(
      baseDeps(async () => ({ maxTurns: 5, escalateOnPlateau: true, escalationMap: {}, maxAttempts: 5 }), {
        configuredGeneratorModel: 'claude-opus-5',
      }),
      task.id
    );
    const out = await leaf.execute(
      baseCtx(task, { lastExit: { kind: 'plateau', dimensions: ['correctness'] }, genEvalTurn: 3 })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ctx = out.value.ctx;
    expect(ctx.lastShouldFailAttempt).toBeUndefined();
    expect((ctx.currentTask as InProgressTask).bestOfNGranted).toBeUndefined();
  });
});
