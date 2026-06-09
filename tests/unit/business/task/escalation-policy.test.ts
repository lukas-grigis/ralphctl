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

  it('climbs the ladder one rung per plateau: haiku → sonnet → opus across successive plateaus', () => {
    // Rung 1: fresh task on haiku plateaus → escalate to sonnet.
    const fresh = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const d1 = decideEscalation({ task: fresh, generatorModel: 'claude-haiku-4-5', flagOn: true, userMap: {} });
    expect(d1.kind).toBe('escalate');
    if (d1.kind === 'escalate') expect(d1.to).toBe('claude-sonnet-4-6');

    // Rung 2: task already escalated to sonnet, now running on sonnet, plateaus → escalate to opus.
    const onSonnet = withEscalation(fresh, 'claude-haiku-4-5', 'claude-sonnet-4-6');
    const d2 = decideEscalation({ task: onSonnet, generatorModel: 'claude-sonnet-4-6', flagOn: true, userMap: {} });
    expect(d2.kind).toBe('escalate');
    if (d2.kind === 'escalate') {
      expect(d2.from).toBe('claude-sonnet-4-6');
      expect(d2.to).toBe('claude-opus-4-8');
    }

    // Top: re-stamped to opus, plateaus on opus (no higher rung, not yet nudged) → nudge.
    const onOpus = withEscalation(onSonnet, 'claude-sonnet-4-6', 'claude-opus-4-8');
    const d3 = decideEscalation({ task: onOpus, generatorModel: 'claude-opus-4-8', flagOn: true, userMap: {} });
    expect(d3.kind).toBe('nudge');

    // After the top-of-ladder nudge (from === to === opus), a further plateau tops out.
    const nudged = withEscalation(onOpus, 'claude-opus-4-8', 'claude-opus-4-8');
    const d4 = decideEscalation({ task: nudged, generatorModel: 'claude-opus-4-8', flagOn: true, userMap: {} });
    expect(d4.kind).toBe('topped-out');
    if (d4.kind === 'topped-out') expect(d4.model).toBe('claude-opus-4-8');
  });

  it('returns nudge when the current model has no rung above (top of ladder, not yet nudged)', () => {
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
    // Stamped from===to so the next plateau detects the top-of-ladder nudge (topped-out); the
    // generator reads escalatedFromModel === escalatedToModel to arm the change-of-approach directive.
    expect(applied.value.task.escalatedFromModel).toBe('claude-opus-4-8');
    expect(applied.value.task.escalatedToModel).toBe('claude-opus-4-8');
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('info');
    expect(banner?.message).toMatch(/change-of-approach directive/);
  });

  it('on topped-out: warn banner, NO blockedReason (preserves work), no model-escalated event', () => {
    const task = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-opus-4-8',
      'claude-opus-4-8'
    );
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'topped-out', model: 'claude-opus-4-8' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // A plateau never blocks — once the ladder is exhausted the work is preserved (done-with-warning).
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('warn');
    expect(banner?.message).toMatch(/ladder exhausted/);
  });

  it('on escalate: re-stamps a task that was already escalated (multi-rung climb)', () => {
    const onSonnet = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-haiku-4-5',
      'claude-sonnet-4-6'
    );
    const { bus } = captureBus();
    const applied = applyEscalation({
      task: onSonnet,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(applied.value.task.escalatedToModel).toBe('claude-opus-4-8');
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
  it('allows a second escalation (re-stamp) as the task climbs the ladder', () => {
    const once = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-haiku-4-5',
      'claude-sonnet-4-6'
    );
    const twice = recordTaskEscalation(once, 'claude-sonnet-4-6', 'claude-opus-4-8');
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    // Fields hold the MOST-RECENT rung transition.
    expect(twice.value.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(twice.value.escalatedToModel).toBe('claude-opus-4-8');
  });

  it('rejects empty model ids', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const blank = recordTaskEscalation(task, '', 'claude-opus-4-8');
    expect(blank.ok).toBe(false);
  });
});
