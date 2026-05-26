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
 * Outputs (discriminated):
 *   - `escalate`          — all conditions met; caller stamps the task + emits events.
 *   - `flag-off`          — operator opted out; caller leaves the path unchanged (today's
 *                           done-with-warning behaviour preserved).
 *   - `already-escalated` — the task already carries `escalatedFromModel`/`escalatedToModel`;
 *                           caller transitions to blocked with no new event (once-per-task cap).
 *   - `no-mapping`        — flag is on but neither the default nor the user map has a rung
 *                           above `generatorModel`; caller emits a `warn` banner and blocks.
 *   - `budget-exhausted`  — flag is on, mapping exists, but the next attempt would exceed
 *                           `maxAttempts`; caller emits a `warn` banner naming the budget
 *                           exhaustion (not the missing mapping) and blocks.
 */
export type EscalationDecision =
  | { readonly kind: 'escalate'; readonly from: string; readonly to: string }
  | { readonly kind: 'flag-off' }
  | { readonly kind: 'already-escalated'; readonly from: string; readonly to: string }
  | { readonly kind: 'no-mapping'; readonly currentModel: string }
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
    return { kind: 'no-mapping', currentModel: props.generatorModel };
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
    case 'already-escalated': {
      const message = `plateau persists after escalation (${decision.from} → ${decision.to}); blocking task`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: 'plateau persists after escalation',
        cause: `${decision.from} → ${decision.to}`,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        from: decision.from,
        to: decision.to,
      });
      return Result.ok({ task, blockedReason: message });
    }
    case 'no-mapping': {
      const message = `plateau at top of configured escalation ladder for '${decision.currentModel}'`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message,
        at: now,
      });
      log.warn(message, { taskId: String(task.id), currentModel: decision.currentModel });
      return Result.ok({ task, blockedReason: message });
    }
    case 'budget-exhausted': {
      const message = `plateau with attempt budget exhausted (attempts=${String(decision.attemptsUsed)}, maxAttempts=${String(decision.maxAttempts)})`;
      eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: 'plateau, attempt budget exhausted',
        cause: `attempts=${String(decision.attemptsUsed)}/${String(decision.maxAttempts)}`,
        at: now,
      });
      log.warn(message, {
        taskId: String(task.id),
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
      });
      return Result.ok({ task, blockedReason: message });
    }
  }
};
