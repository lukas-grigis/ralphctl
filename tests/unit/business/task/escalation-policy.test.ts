import { describe, expect, it } from 'vitest';
import { applyEscalation, decideEscalation, escalationBannerId } from '@src/business/task/escalation-policy.ts';
import { EFFORT_ESCALATION_TARGET } from '@src/business/task/escalation-map.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { resolveEffort } from '@src/business/settings/resolve-effort.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import {
  recordTaskBestOfNGrant,
  recordTaskEffortEscalation,
  recordTaskEscalation,
} from '@src/domain/entity/task-settle.ts';
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

/** Build a task nudged at the top of the ladder on `model` — the exact precondition the
 * best-of-N remedy (and `topped-out`) both consult. */
const nudgedAtTopOn = (task: InProgressTask, model: string): InProgressTask => withEscalation(task, model, model);

const withBestOfNGrant = (task: InProgressTask, n: number): InProgressTask => {
  const stamped = recordTaskBestOfNGrant(task, n);
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

  it('climbs the ladder one rung per plateau: haiku → sonnet-5 → opus-5 across successive plateaus', () => {
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

    // Rung 2: task already escalated to sonnet, now running on sonnet, plateaus → escalate to the
    // default Opus (Opus 5) — the same-price, strictly-better successor.
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
      expect(d2.to).toBe('claude-opus-5');
    }

    // Top: re-stamped to opus-5, plateaus on opus-5 (no higher rung, not yet nudged) → nudge.
    const onOpus = withEscalation(onSonnet, 'claude-sonnet-5', 'claude-opus-5');
    const d3 = decideEscalation({
      task: onOpus,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(d3.kind).toBe('nudge');

    // After the top-of-ladder nudge (from === to === opus-5), a further plateau tops out.
    const nudged = withEscalation(onOpus, 'claude-opus-5', 'claude-opus-5');
    const d4 = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(d4.kind).toBe('topped-out');
    if (d4.kind === 'topped-out') expect(d4.model).toBe('claude-opus-5');
  });

  it('gives pinned Opus-4.8 configs a live model rung to the same-price Opus 5 successor', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-opus-4-8',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') expect(decision.to).toBe('claude-opus-5');
  });

  it('returns nudge when the current model has no rung above (top of ladder, not yet nudged)', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') expect(decision.currentModel).toBe('claude-opus-5');
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

  it('(b) claude opus-5 at explicit `high` → effort rung climbs to `xhigh` (headroom remains)', () => {
    // `high` is below the xhigh/max power tiers on an xhigh-capable model, so it still escalates —
    // to `xhigh` (the first power tier). A later plateau at `xhigh` would then climb to `max`.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-5',
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

  it('(b2) claude opus-5 already at `max` → no headroom, falls through to the same-model nudge', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: 'max',
    });
    expect(decision.kind).toBe('nudge');
    if (decision.kind === 'nudge') expect(decision.currentModel).toBe('claude-opus-5');
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
      generatorModel: 'claude-opus-5',
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
      'claude-opus-5',
      'claude-opus-5'
    );
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
    });
    expect(decision.kind).toBe('topped-out');
  });
});

describe('decideEscalation — evaluator lockstep effort bump', () => {
  it('computes the evaluator target from its OWN provider/model/effort — not copied from the generator target', () => {
    // Generator: shipped default (opus, effort unset) → climbs to `max` (Claude xhigh-capable).
    // Evaluator: a DIFFERENT provider/model (Copilot) → climbs to a DIFFERENT target (`high`). If the
    // evaluator field were ever copied from the generator's `to`, this would assert `max` and fail.
    const generatorRow = DEFAULT_SETTINGS.ai.implement.generator;
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: generatorRow.model,
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: generatorRow.provider,
      generatorEffort: resolveEffort('implement', DEFAULT_SETTINGS),
      evaluatorProvider: 'github-copilot',
      evaluatorModel: 'gpt-5.5',
      evaluatorEffort: undefined,
    });
    expect(decision.kind).toBe('escalate-effort');
    if (decision.kind !== 'escalate-effort') return;
    expect(decision.to).toBe('max');
    expect(decision.evaluator).toEqual({ from: 'default', to: 'high' });
  });

  it('fires in lockstep on a plain MODEL-rung escalate too — the Verification Horizon rule is not limited to escalate-effort', () => {
    // #256's lockstep extended: every generator MODEL climb also carries the evaluator's own
    // effort bump when headroom exists, not only the same-model effort rung.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      evaluatorProvider: 'github-copilot',
      evaluatorModel: 'gpt-5.5',
      evaluatorEffort: undefined,
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind !== 'escalate') return;
    expect(decision.to).toBe('claude-opus-4-8');
    expect(decision.evaluator).toEqual({ from: 'default', to: 'high' });
  });

  it('is absent on a plain model escalate when the caller supplies no evaluator context', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('escalate');
    expect('evaluator' in decision).toBe(false);
  });

  it('is absent on a model escalate when the evaluator is already at its own effort ceiling', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      evaluatorProvider: 'github-copilot',
      evaluatorModel: 'gpt-5.5',
      evaluatorEffort: 'high',
    });
    expect(decision.kind).toBe('escalate');
    if (decision.kind !== 'escalate') return;
    expect(decision.to).toBe('claude-opus-4-8');
    expect(decision.evaluator).toBeUndefined();
  });

  it('is absent on a same-model nudge (generator has no effort headroom of its own)', () => {
    // Claude Haiku has no effort dimension, so the GENERATOR rung never fires (falls through to
    // nudge) even though evaluator context is supplied — the evaluator bump only rides the
    // generator's OWN escalate-effort event, never fires independently.
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-haiku-4-5',
      flagOn: true,
      userMap: { 'claude-haiku-4-5': 'claude-haiku-4-5' },
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
      evaluatorProvider: 'github-copilot',
      evaluatorModel: 'gpt-5.5',
      evaluatorEffort: undefined,
    });
    expect(decision.kind).toBe('nudge');
    expect('evaluator' in decision).toBe(false);
  });

  it('is absent on flag-off', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      generatorModel: 'claude-opus-5',
      flagOn: false,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
      evaluatorProvider: 'github-copilot',
      evaluatorModel: 'gpt-5.5',
      evaluatorEffort: undefined,
    });
    expect(decision.kind).toBe('flag-off');
    expect('evaluator' in decision).toBe(false);
  });

  it('is absent when the evaluator is already at its own effort ceiling, even while the generator rung fires', () => {
    const decision = decideEscalation({
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      // Top of the model ladder (no outbound rung) so the generator hits the effort rung, not a
      // model climb — `claude-opus-4-8` would climb to `claude-opus-5` instead.
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code',
      generatorEffort: undefined,
      evaluatorProvider: 'claude-code',
      evaluatorModel: 'claude-opus-5',
      evaluatorEffort: 'max',
    });
    expect(decision.kind).toBe('escalate-effort');
    if (decision.kind !== 'escalate-effort') return;
    // The generator still climbed (max headroom) — only the evaluator half is missing.
    expect(decision.to).toBe('max');
    expect(decision.evaluator).toBeUndefined();
  });

  it('a single-step Copilot evaluator ladder jumps to `high` once and stays there on a later round', () => {
    const base = {
      task: makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }),
      // Top of the model ladder so the generator's own rung is the effort rung both rounds.
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      generatorProvider: 'claude-code' as const,
      generatorEffort: undefined,
      evaluatorProvider: 'github-copilot' as const,
      evaluatorModel: 'gpt-5.5',
    };
    const first = decideEscalation({ ...base, evaluatorEffort: undefined });
    expect(first.kind).toBe('escalate-effort');
    if (first.kind === 'escalate-effort') expect(first.evaluator).toEqual({ from: 'default', to: 'high' });

    // A later round reads the raised effort back — Copilot's single-step ladder has no rung above
    // `high`, so the evaluator field disappears (spent) even though the generator's own effort rung
    // fires again on a different model.
    const second = decideEscalation({ ...base, evaluatorEffort: 'high' });
    expect(second.kind).toBe('escalate-effort');
    if (second.kind === 'escalate-effort') expect(second.evaluator).toBeUndefined();
  });
});

describe('decideEscalation — opt-in best-of-N remedy', () => {
  it('fires at the exact topped-out frontier when the knob is >= 2 and the task has not been granted one', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 3,
    });
    expect(decision.kind).toBe('best-of-n');
    if (decision.kind !== 'best-of-n') return;
    expect(decision.n).toBe(3);
    expect(decision.model).toBe('claude-opus-5');
  });

  it('knob gating: 0 (default/disabled) still tops out at the same frontier', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 0,
    });
    expect(decision.kind).toBe('topped-out');
  });

  it('knob gating: undefined (never wired) behaves exactly like 0', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
    });
    expect(decision.kind).toBe('topped-out');
  });

  it('knob gating: 1 does not count as opted-in (below the useful minimum) — tops out', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 1,
    });
    expect(decision.kind).toBe('topped-out');
  });

  it('once-per-task: a task already granted best-of-N routes straight to topped-out, even with the knob on', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 }), 'claude-opus-5');
    const alreadyGranted = withBestOfNGrant(nudged, 3);
    const decision = decideEscalation({
      task: alreadyGranted,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 3,
    });
    expect(decision.kind).toBe('topped-out');
  });

  it('does not preempt the FIRST top-of-ladder plateau (not yet nudged) — the nudge still spends first', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 3,
    });
    expect(decision.kind).toBe('nudge');
  });

  it('does not preempt a live MODEL rung — a model with a stronger rung above it still escalates', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const decision = decideEscalation({
      task,
      generatorModel: 'claude-sonnet-4-6',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 3,
    });
    expect(decision.kind).toBe('escalate');
  });

  it('budget-exhausted still wins over best-of-N at the budget edge', () => {
    const nudged = nudgedAtTopOn(makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 }), 'claude-opus-5');
    const decision = decideEscalation({
      task: nudged,
      generatorModel: 'claude-opus-5',
      flagOn: true,
      userMap: {},
      fallbackMaxAttempts: 3,
      bestOfNCandidates: 3,
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

  it('on escalate: forwards plateauSource onto the model-escalated event when supplied', () => {
    // Pure instrumentation: the caller (finalize-gen-eval) forwards WHICH plateau detector fired
    // so the model-bump audit can attribute the escalation without re-deriving it from the
    // progress journal.
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();

    const applied = applyEscalation({
      task,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      trigger: 'plateau',
      plateauSource: 'diversity',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);

    const escalated = events.find(
      (e): e is Extract<AppEvent, { type: 'model-escalated' }> => e.type === 'model-escalated'
    );
    expect(escalated?.plateauSource).toBe('diversity');
  });

  it('on escalate: omits plateauSource from the event when the caller does not supply it', () => {
    // Legacy/budget-exhausted path — no plateau detector involved, so the field is absent
    // (never `undefined`-valued) rather than defaulting to a guessed source.
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();

    applyEscalation({
      task,
      decision: { kind: 'escalate', from: 'claude-sonnet-4-6', to: 'claude-opus-4-8' },
      trigger: 'budget-exhausted',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });

    const escalated = events.find(
      (e): e is Extract<AppEvent, { type: 'model-escalated' }> => e.type === 'model-escalated'
    );
    expect(escalated).toBeDefined();
    expect(escalated?.plateauSource).toBeUndefined();
    expect('plateauSource' in (escalated ?? {})).toBe(false);
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

  it('on best-of-n: info banner naming N + verification-then-judging, NO stamping, no model-escalated event', () => {
    // Mirrors escalate-effort's announce-only posture: applyEscalation narrates the remedy but the
    // once-per-task grant stamp is applied by the CALLER (finalize-gen-eval), not here.
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { bus, events } = captureBus();
    const applied = applyEscalation({
      task,
      decision: { kind: 'best-of-n', n: 3, model: 'claude-opus-5' },
      trigger: 'plateau',
      eventBus: bus,
      logger: noopLogger,
      clock: fixedClock,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.task).toBe(task); // unchanged — no bestOfNGranted stamp here
    expect(applied.value.blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'model-escalated')).toBe(false);
    const banner = events.find((e): e is Extract<AppEvent, { type: 'banner-show' }> => e.type === 'banner-show');
    expect(banner?.tier).toBe('info');
    expect(banner?.message).toMatch(/3 candidates/);
    expect(banner?.message).toMatch(/verification then judging/);
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

describe('recordTaskBestOfNGrant domain helper', () => {
  it('stamps the permanent bestOfNGranted marker + the transient candidate count', () => {
    const task = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const stamped = recordTaskBestOfNGrant(task, 3);
    expect(stamped.ok).toBe(true);
    if (!stamped.ok) return;
    expect(stamped.value.bestOfNGranted).toBe(true);
    expect(stamped.value.bestOfNGrantedCandidates).toBe(3);
    // Orthogonal to the model/effort escalation fields — none of those are touched.
    expect(stamped.value.escalatedFromModel).toBeUndefined();
    expect(stamped.value.escalatedToModel).toBeUndefined();
    expect(stamped.value.escalatedToEffort).toBeUndefined();
  });

  it('rejects n=1 (below the useful minimum)', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    expect(recordTaskBestOfNGrant(task, 1).ok).toBe(false);
  });

  it('rejects n=0', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    expect(recordTaskBestOfNGrant(task, 0).ok).toBe(false);
  });

  it('rejects a non-integer n', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    expect(recordTaskBestOfNGrant(task, 2.5).ok).toBe(false);
  });
});
