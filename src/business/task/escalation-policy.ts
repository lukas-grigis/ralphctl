import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { mergeEscalationMap } from '@src/business/task/escalation-map.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Pure policy that decides whether a plateau exit should escalate the generator model. Lives
 * separate from {@link finalizeGenEvalUseCase} so the once-per-task cap + budget edge + map
 * lookup logic is independently unit-testable (no taskRepo / bus stubs needed for the
 * decision itself).
 *
 * Inputs:
 *   - `task`              — the in-flight task with the just-finished plateau attempt.
 *   - `generatorModel`    — the model id the just-finished attempt's generator ran on.
 *   - `flagOn`            — `settings.harness.escalateOnPlateau`.
 *   - `userMap`           — `settings.harness.escalationMap`; merged over the built-in default.
 *
 * A plateau NEVER blocks. It either grants one more attempt (with a stronger model and/or a
 * change-of-approach directive) or preserves the work (done-with-warning) — never throws it away.
 *
 * Outputs (discriminated):
 *   - `escalate`          — a stronger model rung exists; caller stamps the task (model bump) +
 *                           emits events. Task stays in_progress for one more attempt.
 *   - `nudge`             — flag on, budget remains, but no stronger rung (generator already at
 *                           the top of the ladder). Caller stamps the task with the SAME model so
 *                           the once-per-task cap fires, and the generator gets a change-of-approach
 *                           directive. Task stays in_progress for one more attempt. No model change.
 *   - `flag-off`          — operator opted out; caller leaves the path unchanged (done-with-warning).
 *   - `already-escalated` — the task already had its one plateau-break attempt and plateaued again;
 *                           caller preserves the work (done-with-warning), no new event.
 *   - `budget-exhausted`  — flag on but the next attempt would exceed `maxAttempts` (no budget to
 *                           retry); caller preserves the work (done-with-warning) naming the budget.
 */
export type EscalationDecision =
  | { readonly kind: 'escalate'; readonly from: string; readonly to: string }
  | { readonly kind: 'nudge'; readonly currentModel: string }
  | { readonly kind: 'flag-off' }
  | { readonly kind: 'already-escalated'; readonly from: string; readonly to: string }
  | { readonly kind: 'budget-exhausted'; readonly attemptsUsed: number; readonly maxAttempts: number };

export interface DecideEscalationProps {
  readonly task: InProgressTask;
  readonly generatorModel: string;
  readonly flagOn: boolean;
  readonly userMap: Readonly<Record<string, string>>;
}

/**
 * Pure decision function. Walks the conditions in priority order: flag → already-escalated →
 * budget → mapping. Budget is checked before mapping so the operator sees a precise reason
 * when both conditions fail simultaneously (the docs explicitly call this out — "On budget
 * edge: emit warn naming budget exhaustion, not missing mapping").
 */
export const decideEscalation = (props: DecideEscalationProps): EscalationDecision => {
  if (!props.flagOn) return { kind: 'flag-off' };
  if (props.task.escalatedFromModel !== undefined && props.task.escalatedToModel !== undefined) {
    return {
      kind: 'already-escalated',
      from: props.task.escalatedFromModel,
      to: props.task.escalatedToModel,
    };
  }
  if (props.task.maxAttempts !== undefined && props.task.attempts.length >= props.task.maxAttempts) {
    return {
      kind: 'budget-exhausted',
      attemptsUsed: props.task.attempts.length,
      maxAttempts: props.task.maxAttempts,
    };
  }
  const effective = mergeEscalationMap(props.userMap);
  const to = effective[props.generatorModel];
  if (to === undefined || to === props.generatorModel) {
    // No stronger model to climb to (generator at the top of the ladder). Don't block — grant one
    // more attempt on the same model with a change-of-approach directive instead.
    return { kind: 'nudge', currentModel: props.generatorModel };
  }
  return { kind: 'escalate', from: props.generatorModel, to };
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
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

export interface ApplyEscalationOutput {
  readonly task: InProgressTask;
  readonly blockedReason?: string;
}

/**
 * Side-effecting half of the policy — given a {@link decideEscalation} verdict, emit the
 * matching banner + log lines and (for the happy path) return the task with the escalation
 * fields stamped. Failure paths return the task unchanged plus a `blockedReason` the caller
 * threads into settle-attempt so the task lands blocked.
 *
 * The `flag-off` decision short-circuits — the caller leaves the existing behaviour intact
 * (today's done-with-warning settle) so opting out cleanly preserves the v0.7.0 path.
 */
export const applyEscalation = (
  props: ApplyEscalationProps
): Result<ApplyEscalationOutput, InvalidStateError | ValidationError> => {
  const { task, decision, eventBus, clock } = props;
  const log = props.logger.named('task.escalation-policy');
  const bannerId = escalationBannerId(String(task.id));
  const now = clock();

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
        reason: 'plateau',
        at: now,
      });
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'info',
        message: `escalated generator model: ${decision.from} → ${decision.to}`,
        cause: 'plateau',
        at: now,
      });
      log.info(`escalating generator model: ${decision.from} → ${decision.to}`, {
        taskId: String(task.id),
        attemptN: task.attempts.length,
        from: decision.from,
        to: decision.to,
        reason: 'plateau',
      });
      return Result.ok({ task: stamped.value });
    }
    case 'nudge': {
      // Top of the in-provider ladder: no stronger model to climb to. Keep the model but grant one
      // more attempt with a change-of-approach directive (armed in the generator via
      // `escalatedFromModel`). Stamp from===to so the once-per-task cap still fires on a second
      // plateau (then `already-escalated` preserves the work). No model-escalated event — the model
      // did not change; the banner names the nudge so the operator sees what happened.
      const stamped = recordTaskEscalation(task, decision.currentModel, decision.currentModel);
      if (!stamped.ok) return Result.error(stamped.error);
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'info',
        message: `plateau on '${decision.currentModel}' (top of ladder) — retrying with a change-of-approach directive`,
        cause: 'plateau',
        at: now,
      });
      log.info('plateau nudge: retrying on the same model with a change-of-approach directive', {
        taskId: String(task.id),
        currentModel: decision.currentModel,
      });
      return Result.ok({ task: stamped.value });
    }
    case 'already-escalated': {
      // The one plateau-break attempt also plateaued. Preserve the work (done-with-warning) rather
      // than blocking — matches the flag-off path; a plateau never throws the work away. The warn
      // banner tells the operator the retry topped out.
      const message = `plateau persists after the retry; keeping the work`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: 'plateau persists after retry — keeping the work',
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        from: decision.from,
        to: decision.to,
      });
      return Result.ok({ task });
    }
    case 'budget-exhausted': {
      // Plateau on the final allowed attempt — no budget left to retry. Preserve the work.
      const message = `plateau with attempt budget exhausted (attempts=${String(decision.attemptsUsed)}, maxAttempts=${String(decision.maxAttempts)}); keeping the work`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: 'plateau, attempt budget exhausted — keeping the work',
        cause: `attempts=${String(decision.attemptsUsed)}/${String(decision.maxAttempts)}`,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
      });
      return Result.ok({ task });
    }
  }
};
