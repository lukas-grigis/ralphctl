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
import { recordRunningAttemptWarning } from '@src/domain/entity/task-attempts.ts';

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
  // ── Core exit-kind mapping — every case asserts the FULL output shape so a mutant that
  // drops the warning, flips the verdict, or inverts shouldFailAttempt must fail. ──────────

  // ── passed exit strips a softened-plateau warning (grace round succeeded) ───────────────────
  it('passed exit with prior softened-plateau warning on the running attempt → warning stripped, verdict passed', async () => {
    // Mutant-kill: a mutant that removes the `clearRunningAttemptPlateauWarning` call on the
    // passed path would leave the softened-plateau warning in place, causing a clean pass to be
    // branded pass-with-warning. The assertion on result.value.task must confirm no warning.
    const base = makeInProgressTaskWithRunningAttempt();
    // Stamp a softened-plateau warning on the running attempt (simulating what the evaluator
    // leaf does mid-loop when the work-product exemption fires).
    const withWarning = recordRunningAttemptWarning(base, { kind: 'plateau', dimensions: ['correctness'] });
    if (!withWarning.ok) throw withWarning.error;
    const result = await finalizeGenEvalUseCase({
      task: withWarning.value,
      sprintId,
      exit: { kind: 'passed' },
      turnsUsed: 2,
      readConfig: config,
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('passed');
    expect(result.value.warning).toBeUndefined();
    // Confirm the task entity itself has no warning — the strip must have persisted.
    const runningAttempt = result.value.task.attempts.at(-1);
    expect(runningAttempt?.warning).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('passed exit → verdict passed, no warning, no blockedReason, shouldFailAttempt absent', async () => {
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
    if (!result.ok) return;
    expect(result.value.verdict).toBe('passed');
    expect(result.value.warning).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('self-blocked exit → verdict failed, blockedReason set, no warning, no shouldFailAttempt', async () => {
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
    if (!result.ok) return;
    expect(result.value.verdict).toBe('failed');
    expect(result.value.blockedReason).toBe('no key');
    expect(result.value.warning).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('malformed exit (flag-off) → verdict malformed, warning kind=malformed with detail, no blockedReason, no shouldFailAttempt', async () => {
    // flag-off path: shouldFailAttempt must be absent (not just falsy) — a mutant inverting the
    // flag-off guard would incorrectly set it.
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'malformed', detail: 'no verdict' },
      turnsUsed: 1,
      readConfig: config, // escalateOnPlateau: false
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('malformed');
    expect(result.value.warning).toBeDefined();
    expect(result.value.warning?.kind).toBe('malformed');
    expect((result.value.warning as { kind: 'malformed'; detail: string } | undefined)?.detail).toBe('no verdict');
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('plateau exit (flag-off) → verdict failed, NO warning (mapExit for plateau emits no warning), no blockedReason, no shouldFailAttempt', async () => {
    // mapExit for plateau returns { verdict: 'failed' } — no warning. The plateau exit signals
    // a process failure (escalation policy handles it), not a done-with-warning outcome.
    // flag-off: escalation must NOT fire — shouldFailAttempt absent.
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'plateau', dimensions: ['correctness'] },
      turnsUsed: 3,
      readConfig: config, // escalateOnPlateau: false
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('failed');
    // plateau mapExit produces NO warning — this is intentional design: plateau is an escalation
    // trigger, not a done-with-warning. Mutant-kill: a mutant returning 'passed' as verdict fails here.
    expect(result.value.warning).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('budget-exhausted exit explicit (flag-off) → verdict failed, warning with turnsUsed+turnBudget, no shouldFailAttempt', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const result = await finalizeGenEvalUseCase({
      task,
      sprintId,
      exit: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      turnsUsed: 5,
      readConfig: config, // escalateOnPlateau: false
      taskRepo: okRepo,
      logger: noopLogger,
      eventBus: newBus(),
      clock: fixedClock,
      generatorModel: defaultModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeDefined();
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    const w = result.value.warning as { kind: 'budget-exhausted'; turnsUsed: number; turnBudget: number } | undefined;
    expect(w?.turnsUsed).toBe(5);
    expect(w?.turnBudget).toBe(5);
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
  });

  it('synthesises budget-exhausted exit when exit is undefined — exit kind, warning, verdict all set', async () => {
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
    if (!result.ok) return;
    expect(result.value.exit.kind).toBe('budget-exhausted');
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeDefined();
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    const w = result.value.warning as { kind: 'budget-exhausted'; turnBudget: number } | undefined;
    expect(w?.turnBudget).toBe(7);
    expect(result.value.blockedReason).toBeUndefined();
  });

  it('clamps an unreasonable maxTurns config to >= 1 — turnBudget in synthesized warning is 1', async () => {
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
    if (!result.ok) return;
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    const w = result.value.warning as { kind: 'budget-exhausted'; turnBudget: number } | undefined;
    expect(w?.turnBudget).toBe(1);
    expect(result.value.verdict).toBe('failed');
    expect(result.value.blockedReason).toBeUndefined();
  });

  it('plateau + escalateOnPlateau=false: legacy path — verdict failed, no warning, no escalation event, no blockedReason, no shouldFailAttempt', async () => {
    // Mutant-kill: a mutant that removes the flag-off guard would incorrectly set shouldFailAttempt.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau escalate: verdict failed, no warning (plateau mapExit), shouldFailAttempt=true, escalation stamps + event, no blockedReason', async () => {
    // Mutant-kill: a mutant that flips verdict→'passed' or inverts shouldFailAttempt must fail.
    // Note: plateau mapExit does NOT produce a warning — the warning field must be undefined.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(true);
  });

  it('plateau topped-out (nudged then plateaued again): verdict failed, no warning (plateau mapExit), no shouldFailAttempt, no blockedReason (preserves work)', async () => {
    // Mutant-kill: a mutant that drops the topped-out guard would incorrectly set shouldFailAttempt.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau nudge at top-of-ladder: verdict failed, no warning (plateau mapExit), shouldFailAttempt=true, same-model stamp, no blockedReason', async () => {
    // Mutant-kill: verdict must be 'failed' (not 'passed'); warning must be undefined.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.task.escalatedFromModel).toBe('claude-opus-4-8');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('plateau budget-edge (maxAttempts=1 exhausted): verdict failed, no warning (plateau mapExit), no shouldFailAttempt, no blockedReason (preserves work)', async () => {
    // Mutant-kill: a mutant that omits the attempt-budget guard would set shouldFailAttempt here.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  // ── Broadened escalation gate (budget-exhausted exits) ───────────────────────────────────────

  it('budget-exhausted (real) escalate: verdict failed, budget-exhausted warning with counts, shouldFailAttempt=true, escalation stamp + event with reason, no blockedReason', async () => {
    // Mutant-kill: warning payload (turnsUsed/turnBudget), escalation fields, and event reason
    // must all be asserted so a mutant dropping any of them fails.
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
    const w = result.value.warning as { kind: 'budget-exhausted'; turnsUsed: number; turnBudget: number } | undefined;
    expect(w?.turnsUsed).toBe(5);
    expect(w?.turnBudget).toBe(5);
    expect(result.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    const escalated = events.find((e) => e.type === 'model-escalated');
    expect(escalated).toBeDefined();
    expect(escalated?.reason).toBe('budget-exhausted');
  });

  it('budget-exhausted (synthesized) escalate: verdict failed, budget-exhausted warning, exit.kind matches, escalation stamp, shouldFailAttempt=true, no blockedReason', async () => {
    // Mutant-kill: the synthesized path must produce the same full output shape as the explicit path.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(true);
  });

  it('budget-exhausted budget-edge (maxAttempts=1 exhausted): verdict failed, budget-exhausted warning with counts, no shouldFailAttempt, no blockedReason, no escalation', async () => {
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
    const w = result.value.warning as { kind: 'budget-exhausted'; turnsUsed: number; turnBudget: number } | undefined;
    expect(w?.turnsUsed).toBe(5);
    expect(w?.turnBudget).toBe(5);
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('budget-exhausted flag-off legacy path: verdict failed, budget-exhausted warning, no shouldFailAttempt, no escalation, no blockedReason', async () => {
    // Mutant-kill: a mutant that removes the flag-off guard would set shouldFailAttempt here.
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning?.kind).toBe('budget-exhausted');
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  // ── Malformed: plain same-model retry, no ladder rung ─────────────────────────────────────────

  it('malformed same-model retry (flag-on, budget remaining): verdict malformed, malformed warning with detail, shouldFailAttempt=true, NO escalation stamp, no blockedReason', async () => {
    // Mutant-kill: warning detail must be asserted so a mutant swapping it for plateau warning fails.
    // The evaluator failed, not the generator — no ladder rung burned, no escalation fields stamped.
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
    expect((result.value.warning as { kind: 'malformed'; detail: string } | undefined)?.detail).toBe('no verdict');
    expect(result.value.shouldFailAttempt).toBe(true);
    // No model escalation: the evaluator failed, not the generator — no ladder rung is burned.
    expect(result.value.task.escalatedFromModel).toBeUndefined();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('malformed budget-exhausted (maxAttempts=1): verdict malformed, malformed warning, no shouldFailAttempt, no escalation, no blockedReason', async () => {
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
    expect(result.value.warning?.kind).toBe('malformed');
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
  });

  it('malformed flag-off legacy path: verdict malformed, malformed warning, no shouldFailAttempt, no escalation, no blockedReason', async () => {
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
    expect(result.value.warning?.kind).toBe('malformed');
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.blockedReason).toBeUndefined();
  });

  // ── Legacy-task budget fallback (task.maxAttempts unset) ──────────────────────────────────────

  it('legacy task (no maxAttempts) plateau escalate: verdict failed, no warning (plateau mapExit), shouldFailAttempt=true, escalation stamps set', async () => {
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(result.value.shouldFailAttempt).toBe(true);
    expect(result.value.blockedReason).toBeUndefined();
  });

  it('legacy task (no maxAttempts) plateau fallback=1 preempts: verdict failed, no warning (plateau mapExit), no shouldFailAttempt, no escalation, no blockedReason', async () => {
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
    expect(result.value.verdict).toBe('failed');
    expect(result.value.warning).toBeUndefined(); // plateau mapExit produces no warning
    expect(result.value.task.escalatedToModel).toBeUndefined();
    expect(result.value.shouldFailAttempt).toBeFalsy();
    expect(result.value.blockedReason).toBeUndefined();
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
