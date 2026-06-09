import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { finalizeGenEvalUseCase } from '@src/business/task/finalize-gen-eval.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';

const okRepo: UpdateTask = {
  async update() {
    return Result.ok(undefined);
  },
};
const sprintId = 'sprint-x' as SprintId;
/** Default config helper: flag OFF, generous turn budget, default fallback attempt budget. */
const config = async () => ({ maxTurns: 5, escalateOnPlateau: false, escalationMap: {}, maxAttempts: 3 });
const fixedClock = (): IsoTimestamp => '2026-05-25T00:00:00.000Z' as IsoTimestamp;
const newBus = () => createInMemoryEventBus();
const defaultModel = 'claude-sonnet-4-6';

/** Build a readConfig slice with explicit overrides over the defaults. */
const cfg = (over: Partial<{ maxTurns: number; escalateOnPlateau: boolean; maxAttempts: number }>) => async () => ({
  maxTurns: over.maxTurns ?? 5,
  escalateOnPlateau: over.escalateOnPlateau ?? false,
  escalationMap: {} as Readonly<Record<string, string>>,
  maxAttempts: over.maxAttempts ?? 3,
});

describe('finalizeGenEvalUseCase', () => {
  it('passed exit → verdict passed, no warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'passed' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('passed');
      expect(result.value.warning).toBeUndefined();
      expect(result.value.shouldFailAttempt).toBeFalsy();
    }
  });

  it('self-blocked exit → verdict failed, blockedReason set, no warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'self-blocked', reason: 'no key' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('failed');
      expect(result.value.blockedReason).toBe('no key');
      expect(result.value.warning).toBeUndefined();
      expect(result.value.shouldFailAttempt).toBeFalsy();
    }
  });

  it('malformed exit → verdict malformed, malformed warning', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('malformed');
      expect(result.value.warning?.kind).toBe('malformed');
    }
  });

  it('plateau exit → verdict failed, plateau warning with dimensions', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'plateau') {
      expect(result.value.warning.dimensions).toEqual(['correctness']);
    }
  });

  it('budget-exhausted exit explicit → warning carries turnsUsed + turnBudget', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'budget-exhausted') {
      expect(result.value.warning.turnsUsed).toBe(5);
      expect(result.value.warning.turnBudget).toBe(5);
    }
  });

  it('synthesises budget-exhausted exit when exit is undefined', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      turnsUsed: 7,
      readConfig: cfg({ maxTurns: 7 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit.kind).toBe('budget-exhausted');
      if (result.value.warning?.kind === 'budget-exhausted') {
        expect(result.value.warning.turnBudget).toBe(7);
      }
    }
  });

  it('clamps an unreasonable maxTurns config to >= 1', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      turnsUsed: 0,
      readConfig: cfg({ maxTurns: 0 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.warning?.kind === 'budget-exhausted') {
      expect(result.value.warning.turnBudget).toBe(1);
    }
  });

  it('plateau + escalateOnPlateau=false: legacy path — no escalation event, no blockedReason', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: cfg({ escalateOnPlateau: false, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau + escalateOnPlateau=true + map hit: stamps task, emits event, shouldFailAttempt set', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(true);
  });

  it('plateau + topped-out (already nudged at the top): no new event, NO blockedReason (preserves work), shouldFailAttempt unset', async () => {
    const initial = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    // Task was nudged at the top of the ladder (from === to === opus); plateauing again tops out.
    const stamped = recordTaskEscalation(initial, 'claude-opus-4-8', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task: stamped.value,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-opus-4-8',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The ladder is exhausted: a plateau after the top-of-ladder nudge preserves the work.
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau + flag-on + top-of-ladder: nudge stamps the same model + shouldFailAttempt, no blockedReason', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-opus-4-8',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nudge: same model stamped (arms the directive + once-per-task cap), one more attempt granted.
    expect(result.value.task.escalatedFromModel).toBe('claude-opus-4-8');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau + flag-on + budget edge: warn names budget exhaustion, NO blockedReason (preserves work)', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  // ── Broadened escalation gate (budget-exhausted exits) ───────────────────────────────────────

  it('budget-exhausted (real) + flag-on + budget remaining: escalates, shouldFailAttempt set, event reason=budget-exhausted', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string; reason?: string }> = [];
    bus.subscribe((e) => events.push(e as { type: string; reason?: string }));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    expect(result.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    const escalated = events.find((e) => e.type === 'model-escalated');
    expect(escalated).toBeDefined();
    expect(escalated?.reason).toBe('budget-exhausted');
  });

  it('budget-exhausted (synthesized) + flag-on + budget remaining: escalates, shouldFailAttempt set', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      // No `exit` — synthesised budget-exhausted.
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit.kind).toBe('budget-exhausted');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(events.some((e) => e.type === 'model-escalated')).toBe(true);
  });

  it('budget-exhausted + flag-on + budget exhausted: preserves work (done-with-warning), no shouldFailAttempt', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('budget-exhausted + flag-off: legacy path — no escalation, no shouldFailAttempt', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: false, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  // ── Malformed: plain same-model retry, no ladder rung ─────────────────────────────────────────

  it('malformed + flag-on + budget remaining: plain same-model retry — shouldFailAttempt, NO escalation stamp, NO event', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('malformed');
    expect(result.value.warning?.kind).toBe('malformed');
    expect(result.value.shouldFailAttempt).toBe(true);
    // No model escalation: the evaluator failed, not the generator — no ladder rung is burned.
    expect(result.value.task.escalatedFromModel).toBeUndefined();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('malformed + flag-on + budget exhausted: falls back to done-with-warning, no shouldFailAttempt', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('malformed');
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('malformed + flag-off: legacy done-with-warning even with budget remaining', async () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 5,
      readConfig: cfg({ escalateOnPlateau: false, maxAttempts: 5 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('malformed');
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
  });

  // ── Legacy-task budget fallback (task.maxAttempts unset) ──────────────────────────────────────

  it('legacy task (no maxAttempts) + plateau + flag-on: budget fallback grants a retry while under the configured cap', async () => {
    // No `maxAttempts` override → task.maxAttempts is undefined (legacy plan).
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      // Fallback budget 3 > 1 attempt used → escalate.
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 3 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
  });

  it('legacy task (no maxAttempts) + plateau + flag-on + fallback=1: budget fallback preempts (preserves work)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const bus = newBus();
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      // Fallback budget 1 === 1 attempt used → budget-exhausted, preserve work.
      readConfig: cfg({ escalateOnPlateau: true, maxAttempts: 1 }),
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: bus,
      clock: fixedClock,
      generatorModel: 'claude-sonnet-4-6',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('forwards a StorageError from the repo', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const failing: UpdateTask = {
      async update() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
    };
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'passed' },
      turnsUsed: 1,
      readConfig: config,
      taskRepo: failing,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(false);
  });
});
