import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { escalationLadderCyclicFrom, mergeEscalationMap } from '@src/business/task/escalation-map.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * The gen-eval exit kind that triggered the model-escalation policy. Threaded through so the
 * emitted `model-escalated` event + banner copy name the real cause rather than always saying
 * "plateau". `'malformed'` is absent on purpose — that exit is the evaluator's failure and never
 * climbs the model ladder (the finalize use case routes it to a plain same-model retry instead).
 */
export type EscalationTrigger = 'plateau' | 'budget-exhausted';

/**
 * Human-readable noun for {@link EscalationTrigger}, used in banner / log copy.
 */
const triggerLabel = (trigger: EscalationTrigger): string =>
  trigger === 'plateau' ? 'plateau' : 'turn budget exhausted';

/**
 * Pure policy that decides whether a failure-driven exit should escalate the generator model.
 * Lives separate from {@link finalizeGenEvalUseCase} so the graduated-remedy ladder
 * (cheapest-first, climb the model ladder multiple rungs) + budget edge + map lookup logic is
 * independently unit-testable (no taskRepo / bus stubs needed for the decision itself).
 *
 * Inputs:
 *   - `task`                — the in-flight task with the just-finished escalatable attempt.
 *   - `generatorModel`      — the model the just-finished attempt ran on
 *                             (= `task.escalatedToModel ?? configured`).
 *   - `flagOn`              — `settings.harness.escalateOnPlateau` (gates ALL failure-driven
 *                             escalation, not only plateau — the flag name is retained for
 *                             backward compatibility).
 *   - `userMap`             — `settings.harness.escalationMap`; merged over the built-in default.
 *   - `fallbackMaxAttempts` — effective attempt budget when `task.maxAttempts` is unset (legacy
 *                             tasks planned before the field existed); wired from
 *                             `settings.harness.maxAttempts`.
 *
 * An escalatable exit NEVER blocks. It either grants one more attempt (with a stronger model
 * and/or a change-of-approach directive) or preserves the work (done-with-warning) — never throws
 * it away.
 *
 * The ladder is climbed cheapest-first across SUCCESSIVE escalatable exits: `generatorModel`
 * advances by one rung on each escalate (because the leaf re-reads `escalatedToModel`), so the
 * same policy returns `escalate` repeatedly until the generator reaches the top of the ladder.
 * Only then does the same-model `nudge` fire, and a further failure after the nudge tops out.
 *
 * Outputs (discriminated):
 *   - `escalate`          — a stronger model rung exists above `generatorModel`; caller re-stamps
 *                           the task (model bump) + emits events. Task stays in_progress for the
 *                           next attempt. Fires once per rung, repeatedly up the ladder.
 *   - `nudge`             — flag on, budget remains, but no stronger rung (generator at the top of
 *                           the ladder) AND the task has not yet been nudged at the top. Caller
 *                           stamps the task with the SAME model (from === to marks the top-of-ladder
 *                           nudge), and the generator gets a change-of-approach directive. Task stays
 *                           in_progress for one more attempt. No model change.
 *   - `flag-off`          — operator opted out; caller leaves the path unchanged (done-with-warning).
 *   - `topped-out`        — the task was already nudged at the top of the ladder and failed again;
 *                           caller preserves the work (done-with-warning), no new event.
 *   - `budget-exhausted`  — flag on but the next attempt would exceed the effective `maxAttempts`
 *                           (no budget to retry); caller preserves the work (done-with-warning)
 *                           naming the budget.
 */
export type EscalationDecision =
  | { readonly kind: 'escalate'; readonly from: string; readonly to: string }
  | { readonly kind: 'nudge'; readonly currentModel: string }
  | { readonly kind: 'flag-off' }
  | { readonly kind: 'topped-out'; readonly model: string }
  | { readonly kind: 'budget-exhausted'; readonly attemptsUsed: number; readonly maxAttempts: number };

export interface DecideEscalationProps {
  readonly task: InProgressTask;
  readonly generatorModel: string;
  readonly flagOn: boolean;
  readonly userMap: Readonly<Record<string, string>>;
  /**
   * Effective attempt budget when `task.maxAttempts` is unset. Legacy tasks planned before the
   * field existed (pre-commit 3992de36) carry no per-task cap; without this the budget check
   * would never fire and a legacy task could climb the ladder unbounded. Wired from
   * `settings.harness.maxAttempts`.
   */
  readonly fallbackMaxAttempts: number;
}

/**
 * Pure decision function. Walks the conditions in priority order: flag → budget → mapping →
 * top-of-ladder. Budget is checked before mapping so the operator sees a precise reason when both
 * conditions fail simultaneously (the docs explicitly call this out — "On budget edge: emit warn
 * naming budget exhaustion, not missing mapping").
 *
 * Multi-rung climb: `generatorModel` is the model the just-finished attempt ran on. Because the
 * generator leaf re-reads `escalatedToModel` each attempt, `generatorModel` advances one rung per
 * plateau, so this function returns `escalate` repeatedly until the generator hits the top of the
 * ladder. At the top it returns `nudge` once (same-model retry with a change-of-approach directive),
 * and a further plateau after the nudge returns `topped-out` (keep the work).
 */
export const decideEscalation = (props: DecideEscalationProps): EscalationDecision => {
  if (!props.flagOn) return { kind: 'flag-off' };
  // `task.maxAttempts` is the per-task cap stamped at plan time; legacy tasks lack it, so fall
  // back to the configured `settings.harness.maxAttempts` rather than letting the budget check
  // go silent (which would let a legacy task climb the ladder unbounded). Domain entity untouched.
  const effectiveMaxAttempts = props.task.maxAttempts ?? props.fallbackMaxAttempts;
  if (props.task.attempts.length >= effectiveMaxAttempts) {
    return {
      kind: 'budget-exhausted',
      attemptsUsed: props.task.attempts.length,
      maxAttempts: effectiveMaxAttempts,
    };
  }
  const merged = mergeEscalationMap(props.userMap);
  const next = merged[props.generatorModel];
  if (
    next !== undefined &&
    next !== props.generatorModel &&
    !escalationLadderCyclicFrom(merged, props.generatorModel)
  ) {
    // A stronger rung exists above the model the just-finished attempt ran on. Climb to it. This
    // fires on every plateau as the generator advances up the ladder one rung at a time. The
    // cyclic-chain guard keeps an operator-authored `escalationMap` cycle (`{ a: b, b: a }`, which
    // the self-loop warning misses) from driving an unbounded climb — a model on a cycle falls
    // through to the same-model nudge / topped-out path below instead of escalating forever.
    return { kind: 'escalate', from: props.generatorModel, to: next };
  }
  // Top of the ladder (no rung above `generatorModel`). If the task was already nudged at the top
  // (stamped from === to === generatorModel) and plateaued again, top out and keep the work.
  const nudgedAtTop =
    props.task.escalatedFromModel !== undefined &&
    props.task.escalatedFromModel === props.task.escalatedToModel &&
    props.task.escalatedToModel === props.generatorModel;
  if (nudgedAtTop) return { kind: 'topped-out', model: props.generatorModel };
  // Top of the ladder, not yet nudged. Grant one more attempt on the same model with a
  // change-of-approach directive instead of blocking.
  return { kind: 'nudge', currentModel: props.generatorModel };
};

/**
 * Stable banner id keyed by the task. Re-firing a plateau on the same task overwrites in
 * place (the banner adapter dedups by id), and the matching `banner-clear` from the next
 * generator-leaf start releases the slot.
 */
export const escalationBannerId = (taskId: string): string => `model-escalation-${taskId}`;

export interface ApplyEscalationProps {
  readonly task: InProgressTask;
  readonly decision: EscalationDecision;
  /**
   * The exit kind that triggered the policy — named in the emitted `model-escalated` event +
   * banner / log copy so a budget-exhausted-driven escalation is not mislabeled as a plateau.
   */
  readonly trigger: EscalationTrigger;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

export interface ApplyEscalationOutput {
  readonly task: InProgressTask;
  /**
   * Reserved for a future decision that needs settle-attempt to block the task. No current
   * decision sets it — an escalatable exit never blocks, so escalate / nudge stay `in_progress`
   * and flag-off / topped-out / budget-exhausted preserve the work (done-with-warning). The caller
   * still threads it through defensively.
   */
  readonly blockedReason?: string;
}

/**
 * Side-effecting half of the policy — given a {@link decideEscalation} verdict, emit the
 * matching banner + log lines and (for the happy path) return the task with the escalation
 * fields stamped. The preserve paths (topped-out / budget-exhausted) and flag-off return the
 * task as-is; none set `blockedReason`, because an escalatable exit never blocks. The `trigger`
 * names the originating exit kind in the emitted event + copy.
 *
 * The `flag-off` decision short-circuits — the caller leaves the existing behaviour intact
 * (today's done-with-warning settle) so opting out cleanly preserves the v0.7.0 path.
 */
export const applyEscalation = (props: ApplyEscalationProps): Result<ApplyEscalationOutput, ValidationError> => {
  const { task, decision, trigger, eventBus, clock } = props;
  const log = props.logger.named('task.escalation-policy');
  const bannerId = escalationBannerId(String(task.id));
  const now = clock();
  const cause = triggerLabel(trigger);

  switch (decision.kind) {
    case 'flag-off':
      return Result.ok({ task });
    case 'escalate': {
      const stamped = recordTaskEscalation(task, decision.from, decision.to);
      if (!stamped.ok) return Result.error(stamped.error);
      eventBus.publish({
        type: 'model-escalated',
        taskId: String(task.id),
        attemptN: task.attempts.length,
        from: decision.from,
        to: decision.to,
        reason: trigger,
        at: now,
      });
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'info',
        message: `escalated generator model: ${decision.from} → ${decision.to}`,
        cause,
        at: now,
      });
      log.info(`escalating generator model: ${decision.from} → ${decision.to}`, {
        taskId: String(task.id),
        attemptN: task.attempts.length,
        from: decision.from,
        to: decision.to,
        reason: trigger,
      });
      return Result.ok({ task: stamped.value });
    }
    case 'nudge': {
      // Top of the in-provider ladder: no stronger model to climb to. Keep the model but grant one
      // more attempt with a change-of-approach directive (armed in the generator via the
      // same-model marker `escalatedFromModel === escalatedToModel`). Stamp from===to so the next
      // failure detects the top-of-ladder nudge and returns `topped-out`. No model-escalated event —
      // the model did not change; the banner names the nudge so the operator sees what happened.
      const stamped = recordTaskEscalation(task, decision.currentModel, decision.currentModel);
      if (!stamped.ok) return Result.error(stamped.error);
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'info',
        message: `${cause} on '${decision.currentModel}' (top of ladder) — retrying with a change-of-approach directive`,
        cause,
        at: now,
      });
      log.info('top-of-ladder nudge: retrying on the same model with a change-of-approach directive', {
        taskId: String(task.id),
        currentModel: decision.currentModel,
        reason: trigger,
      });
      return Result.ok({ task: stamped.value });
    }
    case 'topped-out': {
      // The generator climbed to the top of the ladder and the top-of-ladder nudge also failed.
      // Preserve the work (done-with-warning) rather than blocking — matches the flag-off path; an
      // escalatable exit never throws the work away. The warn banner tells the operator the ladder
      // exhausted.
      const message = `ladder exhausted on '${decision.model}' (${cause}); keeping the work`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: 'ladder exhausted — keeping the work',
        cause,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        model: decision.model,
        reason: trigger,
      });
      return Result.ok({ task });
    }
    case 'budget-exhausted': {
      // Escalatable exit on the final allowed attempt — no attempt budget left to retry. Preserve
      // the work.
      const message = `${cause} with attempt budget exhausted (attempts=${String(decision.attemptsUsed)}, maxAttempts=${String(decision.maxAttempts)}); keeping the work`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: `${cause}, attempt budget exhausted — keeping the work`,
        cause: `attempts=${String(decision.attemptsUsed)}/${String(decision.maxAttempts)}`,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
        reason: trigger,
      });
      return Result.ok({ task });
    }
  }
};
