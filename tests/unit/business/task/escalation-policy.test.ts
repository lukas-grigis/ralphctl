import { describe, expect, it } from 'vitest';
import { applyEscalation, decideEscalation, escalationBannerId } from '@src/business/task/escalation-policy.ts';
import { EFFORT_ESCALATION_TARGET } from '@src/business/task/escalation-map.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEffortEscalation, recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
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
      fallbackMaxAttempts: 3,
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
      fallbackMaxAttempts: 3,
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
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') expect(decision.to).toBe('custom-frontier-model');
  });

  it('climbs the ladder one rung per plateau: haiku → sonnet-5 → opus across successive plateaus', () => {
    // Rung 1: fresh task on haiku plateaus → escalate to the default Sonnet (Sonnet 5).
    const fresh = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const d1 = decideEscalation({
      task: fresh,
      generatorModel: 'claude-haiku-4-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(d1.kind).toBe('escalate');
    if (d1.kind === 'escalate') expect(d1.to).toBe('claude-sonnet-5');

    // Rung 2: task already escalated to sonnet, now running on sonnet, plateaus → escalate to opus.
    const onSonnet = withEscalation(fresh, 'claude-haiku-4-5', 'claude-sonnet-5');
    const d2 = decideEscalation({
      task: onSonnet,
      generatorModel: 'claude-sonnet-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(d2.kind).toBe('escalate');
    if (d2.kind === 'escalate') {
      expect(d2.from).toBe('claude-sonnet-5');
      expect(d2.to).toBe('claude-opus-4-8');
    }

    // Top: re-stamped to opus, plateaus on opus (no higher rung, not yet nudged) → nudge.
    const onOpus = withEscalation(onSonnet, 'claude-sonnet-4-6', 'claude-opus-4-8');
    const d3 = decideEscalation({
      task: onOpus,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(d3.kind).toBe('nudge');

    // After the top-of-ladder nudge (from === to === opus), a further plateau tops out.
    const nudged = withEscalation(onOpus, 'claude-opus-4-8', 'claude-opus-4-8');
    const d4 = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
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
      fallbackMaxAttempts: 3,
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
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('nudge');
  });

  it('treats a multi-node user-map cycle as top-of-ladder instead of escalating forever', () => {
    // `{ a: b, b: a }` is a 2-cycle the self-loop warning (`{ a: a }`) does not catch. Without the
    // cyclic-chain guard, model-a → escalate to model-b and model-b → escalate to model-a loop
    // indefinitely, each a real escalate keeping the task in_progress. The guard makes a model on
    // the cycle fall through to the same-model nudge, and a further plateau then tops out — bounded.
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const cyclicMap = { 'model-a': 'model-b', 'model-b': 'model-a' };
    const decision = decideEscalation({
      task,
      generatorModel: 'model-a',
      flagOn: true,
      userMap: cyclicMap,
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') expect(decision.currentModel).toBe('model-a');

    const nudged = withEscalation(task, 'model-a', 'model-a');
    const after = decideEscalation({
      task: nudged,
      generatorModel: 'model-a',
      flagOn: true,
      userMap: cyclicMap,
      fallbackMaxAttempts: 3,
    });
    expect(after.kind).toBe('topped-out');
  });

  it('returns budget-exhausted before checking the map when attempts === maxAttempts', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('budget-exhausted');
  });

  it('falls back to fallbackMaxAttempts when task.maxAttempts is unset (legacy task)', () => {
    // Legacy task: no per-task cap. With one attempt used and a fallback of 1, the budget is
    // exhausted; with a fallback of 3 there is room to climb.
    const legacy = makeInProgressTaskWithRunningAttempt();
    const exhausted = decideEscalation({
      task: legacy,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 1,
    });
    expect(exhausted.kind).toBe('budget-exhausted');
    if (exhausted.kind === 'budget-exhausted') expect(exhausted.maxAttempts).toBe(1);

    const remaining = decideEscalation({
      task: legacy,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(remaining.kind).toBe('escalate');
  });
});

describe('decideEscalation — same-model effort rung', () => {
  it('(a) shipped defaults + plateau → effort rung fires to `max` (opus CLI default is xhigh)', () => {
    // The shipped default generator (`claude-opus-4-8`, effort unset) sits at the top of the model
    // ladder with no stronger rung above it. Claude Code's own default effort on this xhigh-capable
    // model is xhigh, so the rung climbs to `max` in a single step — a fixed `high` would be a no-op
    // / downgrade. Reading the actual shipped defaults grounds this in DEFAULT_SETTINGS, so a future
    // default that is already effort-maxed would fail here rather than silently disabling the rung.
    const generatorRow = DEFAULT_SETTINGS.ai.implement.generator;
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: generatorRow.model,
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: generatorRow.provider,
      generatorEffort: resolveEffort('implement', DEFAULT_SETTINGS),
    });
    expect(decision.kind).toBe('escalate-effort');
    if (decision.kind === 'escalate-effort') {
      expect(decision.model).toBe(generatorRow.model);
      expect(decision.from).toBe('default');
      expect(decision.to).toBe('max');
    }
  });

  it('(b) claude opus at explicit `high` → effort rung climbs to `xhigh` (headroom remains)', () => {
    // `high` is below the xhigh/max power tiers on an xhigh-capable model, so it still escalates —
    // to `xhigh` (the first power tier). A later plateau at `xhigh` would then climb to `max`.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: 'high',
    });
    expect(decision.kind).toBe('escalate-effort');
    if (decision.kind === 'escalate-effort') {
      expect(decision.from).toBe('high');
      expect(decision.to).toBe('xhigh');
    }
  });

  it('(b2) claude opus already at `max` → no headroom, falls through to the same-model nudge', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: 'max',
    });
    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') expect(decision.currentModel).toBe('claude-opus-4-8');
  });

  it('(b3) claude Haiku (no effort dimension) → falls through to the same-model nudge', () => {
    // A user-map rung keeps Haiku at the top of ITS ladder for this test (default map climbs Haiku
    // to Sonnet). With no effort dimension the rung is skipped, so the top-of-ladder path nudges.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-haiku-4-5',
      flagOn: true,
      userMap: { 'claude-haiku-4-5': 'claude-haiku-4-5' },
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
    });
    expect(decision.kind).toBe('nudge');
  });

  it('(c) provider without a resolvable effort dimension → unchanged behaviour (nudge)', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: undefined,
      generatorEffort: undefined,
    });
    expect(decision.kind).toBe('nudge');
  });

  it('does not pre-empt a stronger MODEL rung — model escalation still wins over the effort rung', () => {
    // A model with a rung above it climbs the model ladder first (cheapest-first is the effort rung
    // only once the model ladder is exhausted). Passing effort context must not change that.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') expect(decision.to).toBe('claude-opus-4-8');
  });

  it('a task already nudged at the top does not effort-escalate — it tops out', () => {
    // Once the same-model nudge has been stamped (from === to === model), a further plateau tops out
    // even when effort headroom exists — the nudge is the last remedy before preserving the work.
    const nudged = withEscalation(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      'claude-opus-4-8',
      'claude-opus-4-8'
    );
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
    });
    expect(decision.kind).toBe('topped-out');
  });
});

describe('applyEscalation', () => {
  it('on escalate: stamps task, publishes model-escalated event and info banner', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();

    const applied = applyEscalation({
      task,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      trigger: 'plateau',
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

  it('on escalate-effort: info banner naming the effort bump, NO stamping, no model-escalated event', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'escalate-effort', model: 'claude-opus-4-8', from: 'default', to: EFFORT_ESCALATION_TARGET },
      trigger: 'plateau',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // The model is unchanged, so the escalation model fields stay untouched (the same-model
    // change-of-approach marker is reserved for the LATER nudge).
    expect(applied.value.task.escalatedFromModel).toBeUndefined();
    expect(applied.value.task.escalatedToModel).toBeUndefined();
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('info');
    expect(banner?.message).toMatch(/effort/);
    expect(banner?.message).toMatch(new RegExp(EFFORT_ESCALATION_TARGET));
  });

  it('on nudge: stamps the same model (once-per-task marker), info banner, no blockedReason, no model-escalated event', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'nudge', currentModel: 'claude-opus-4-8' },
      trigger: 'plateau',
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
      trigger: 'plateau',
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
      trigger: 'plateau',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.task.escalatedFromModel).toBe('claude-sonnet-4-6');
    expect(applied.value.task.escalatedToModel).toBe('claude-opus-4-8');
  });

  it('on escalate with trigger=budget-exhausted: event reason + banner cause name the budget exit, not plateau', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();

    const applied = applyEscalation({
      task,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      trigger: 'budget-exhausted',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const escalated = events.find(
      (e): e is Extract<AppEvent, { type: 'model-escalated' }> => e.type === 'model-escalated'
    );
    expect(escalated?.reason).toBe('budget-exhausted');
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.cause).toBe('turn budget exhausted');
  });

  it('on budget-exhausted: warn banner names budget exhaustion, NO blockedReason (preserves work)', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'budget-exhausted', attemptsUsed: 1, maxAttempts: 1 },
      trigger: 'plateau',
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
      trigger: 'plateau',
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

describe('recordTaskEffortEscalation domain helper', () => {
  it('stamps escalatedToEffort and leaves the model fields untouched', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const stamped = recordTaskEffortEscalation(task, EFFORT_ESCALATION_TARGET);
    expect(stamped.ok).toBe(true);
    if (!stamped.ok) return;
    expect(stamped.value.escalatedToEffort).toBe(EFFORT_ESCALATION_TARGET);
    // The effort rung never touches the model — those fields stay untouched.
    expect(stamped.value.escalatedFromModel).toBeUndefined();
    expect(stamped.value.escalatedToModel).toBeUndefined();
  });

  it('rejects an empty effort string', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    expect(recordTaskEffortEscalation(task, '').ok).toBe(false);
  });
});
