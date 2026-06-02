import { describe, expect, it } from 'vitest';
import { applyEscalation, decideEscalation, escalationBannerId } from '@src/business/task/escalation-policy.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const fixedClock = (): IsoTimestamp => '2026-05-25T00:00:00.000Z' as IsoTimestamp;

const captureBus = () => {
  const bus = createInMemoryEventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { bus, events };
};

const withEscalation = (task: InProgressTask, from: string, to: string): InProgressTask => {
  const stamped = recordTaskEscalation(task, from, to);
  if (!stamped.ok) throw stamped.error;
  return stamped.value;
};

describe('decideEscalation', () => {
  it('returns flag-off when escalateOnPlateau is false', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: false,
      userMap: {},
    });
    expect(decision.kind).toBe('flag-off');
  });

  it('returns escalate when default map has a rung above the current model', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') {
      expect(decision.from).toBe('claude-sonnet-4-6');
      expect(decision.to).toBe('claude-opus-4-8');
    }
  });

  it('user map override wins over the built-in default rung', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: { 'claude-sonnet-4-6': 'custom-frontier-model' },
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') expect(decision.to).toBe('custom-frontier-model');
  });

  it('returns already-escalated when the task already carries both escalation fields', () => {
    const task = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-sonnet-4-6',
      'claude-opus-4-8'
    );
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
    });
    expect(decision.kind).toBe('already-escalated');
  });

  it('returns nudge when the current model has no rung above (top of ladder)', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
    });
    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') expect(decision.currentModel).toBe('claude-opus-4-8');
  });

  it('treats self-loop entries (from === to) as a nudge', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: { 'claude-sonnet-4-6': 'claude-sonnet-4-6' },
    });
    expect(decision.kind).toBe('nudge');
  });

  it('returns budget-exhausted before checking the map when attempts === maxAttempts', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
    });
    expect(decision.kind).toBe('budget-exhausted');
  });
});

describe('applyEscalation', () => {
  it('on escalate: stamps task, publishes model-escalated event and info banner', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();

    const applied = applyEscalation({
      task,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(applied.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(applied.value.blockedReason).toBeUndefined();

    const escalated = events.find(
      (e): e is Extract<AppEvent, { type: 'model-escalated' }> => e.type === 'model-escalated'
    );
    expect(escalated).toBeDefined();
    expect(escalated?.from).toBe('claude-sonnet-4-6');
    expect(escalated?.to).toBe('claude-opus-4-8');
    expect(escalated?.reason).toBe('plateau');
    expect(escalated?.taskId).toBe(String(task.id));
    expect(escalated?.attemptN).toBe(1);

    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner).toBeDefined();
    expect(banner?.tier).toBe('info');
    expect(banner?.id).toBe(escalationBannerId(String(task.id)));
  });

  it('on nudge: stamps the same model (once-per-task marker), info banner, no blockedReason, no model-escalated event', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'nudge', currentModel: 'claude-opus-4-8' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // Stamped from===to so the once-per-task cap fires on a second plateau; the generator reads
    // escalatedFromModel to arm the change-of-approach directive.
    expect(applied.value.task.escalatedFromModel).toBe('claude-opus-4-8');
    expect(applied.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('info');
    expect(banner?.message).toMatch(/change-of-approach directive/);
  });

  it('on already-escalated: warn banner, NO blockedReason (preserves work), no model-escalated event', () => {
    const task = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-sonnet-4-6',
      'claude-opus-4-8'
    );
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'already-escalated', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // A plateau never blocks — after the one retry the work is preserved (done-with-warning).
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('warn');
  });

  it('on budget-exhausted: warn banner names budget exhaustion, NO blockedReason (preserves work)', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'budget-exhausted', attemptsUsed: 1, maxAttempts: 1 },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.blockedReason).toBeUndefined();
    expect(applied.value.task.escalatedToModel).toBeUndefined();
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('warn');
    expect(banner?.message).toMatch(/budget exhausted/);
    expect(banner?.message).not.toMatch(/mapping/i);
  });

  it('on flag-off: no events, no blockedReason, no stamping', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'flag-off' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.blockedReason).toBeUndefined();
    expect(applied.value.task.escalatedToModel).toBeUndefined();
    expect(events.length).toBe(0);
  });
});

describe('recordTaskEscalation domain helper', () => {
  it('rejects a second escalation on a task that already carries the fields', () => {
    const once = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-sonnet-4-6',
      'claude-opus-4-8'
    );
    const twice = recordTaskEscalation(once, 'claude-opus-4-8', 'another-model');
    expect(twice.ok).toBe(false);
  });

  it('rejects empty model ids', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const blank = recordTaskEscalation(task, '', 'claude-opus-4-8');
    expect(blank.ok).toBe(false);
  });
});
