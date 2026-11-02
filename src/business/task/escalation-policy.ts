import { Result } from '@src/domain/result.ts';
import { budgetedAttemptCount } from '@src/domain/entity/task-attempts.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import { escalationLadderCyclicFrom, mergeEscalationMap, nextEffortRung } from '@src/business/task/escalation-map.ts';
import { type AiProvider, remapRetiredModel } from '@src/domain/entity/settings.ts';
import type { PlateauSource } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import {
  recordTaskBestOfNGrant,
  recordTaskEffortEscalation,
  recordTaskEscalation,
  recordTaskEvaluatorEffortEscalation,
} from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** Event `type` discriminant for the operator banner every escalation branch publishes. */
const BANNER_SHOW_EVENT = 'banner-show';

/**
 * The exit kind that triggered the policy, named in the event and banner copy. `malformed` is absent
 * on purpose: it is the evaluator's failure and gets a plain same-model retry instead.
 */
export type EscalationTrigger = 'plateau' | 'budget-exhausted';

const triggerLabel = (trigger: EscalationTrigger): string =>
  trigger === 'plateau' ? 'plateau' : 'turn budget exhausted';

/**
 * The evaluator's own same-model effort bump, computed against the evaluator's provider/model/effort
 * (never copied from the generator). The evaluator MODEL never escalates.
 */
interface EvaluatorEffortBump {
  readonly from: string;
  readonly to: string;
}

/**
 * The remedy ladder, cheapest first, across successive escalatable exits:
 *
 *   - `escalate`         — a stronger model rung exists; climb one rung. Carries the evaluator effort
 *                          bump on every climb (a fixed verifier weakens as the generator strengthens).
 *   - `escalate-effort`  — top of the model ladder: raise the generator's effort on the same model
 *                          ({@link nextEffortRung}); needs `generatorProvider`.
 *   - `nudge`            — no effort headroom: same model, change-of-approach directive (from === to).
 *   - `best-of-n`        — nudged and failed again; on by default (`0` turns it off), once per task, samples `n` candidates.
 *   - `topped-out`       — nothing left; keep the work (done-with-warning).
 *   - `flag-off`         — operator opted out; keep the work.
 *   - `budget-exhausted` — no attempt left to retry; keep the work, naming the budget.
 *
 * An escalatable exit never blocks. Research: `.claude/docs/RESEARCH-REFERENCES.md` (Verification
 * Horizon lockstep, best-of-N rung).
 */
export type EscalationDecision =
  | { readonly kind: 'escalate'; readonly from: string; readonly to: string; readonly evaluator?: EvaluatorEffortBump }
  | {
      readonly kind: 'escalate-effort';
      readonly model: string;
      readonly from: string;
      readonly to: string;
      readonly evaluator?: EvaluatorEffortBump;
    }
  | { readonly kind: 'nudge'; readonly currentModel: string }
  | { readonly kind: 'best-of-n'; readonly n: number; readonly model: string }
  | { readonly kind: 'flag-off' }
  | { readonly kind: 'topped-out'; readonly model: string }
  | { readonly kind: 'budget-exhausted'; readonly attemptsUsed: number; readonly maxAttempts: number };

export interface DecideEscalationProps {
  readonly task: InProgressTask;
  /** The model the just-finished attempt ran on; advances one rung per escalate. */
  readonly generatorModel: string;
  /** `settings.harness.escalateOnPlateau` — gates ALL failure-driven escalation despite its name. */
  readonly flagOn: boolean;
  readonly userMap: Readonly<Record<string, string>>;
  /** Budget when `task.maxAttempts` is unset (legacy tasks) — without it a legacy task climbs unbounded. */
  readonly fallbackMaxAttempts: number;
  /** Selects the built-in ladder and enables `escalate-effort`; absent → only the user's rungs, no effort rung. */
  readonly generatorProvider?: AiProvider | undefined;
  /** Resolved generator effort; `undefined` = CLI default. */
  readonly generatorEffort?: string | undefined;
  /** Evaluator triple for {@link EvaluatorEffortBump}; no `evaluatorModel` → no bump. */
  readonly evaluatorProvider?: AiProvider | undefined;
  readonly evaluatorModel?: string | undefined;
  readonly evaluatorEffort?: string | undefined;
  /** `settings.harness.bestOfNCandidates` (0 or 2-4); `< 2` disables the `best-of-n` rung. */
  readonly bestOfNCandidates?: number | undefined;
}

const computeEvaluatorEffortCarry = (props: DecideEscalationProps): { readonly evaluator?: EvaluatorEffortBump } => {
  const to =
    props.evaluatorModel !== undefined
      ? nextEffortRung(props.evaluatorProvider, props.evaluatorModel, props.evaluatorEffort)
      : undefined;
  return to !== undefined ? { evaluator: { from: props.evaluatorEffort ?? 'default', to } } : {};
};

/** False for an unmapped model, a self-loop, or an operator-authored cycle (`{ a: b, b: a }`). */
const hasStrongerModelRung = (
  merged: Readonly<Record<string, string>>,
  generatorModel: string,
  next: string | undefined
): next is string =>
  next !== undefined && next !== generatorModel && !escalationLadderCyclicFrom(merged, generatorModel);

/** The nudge stamps `escalatedFromModel === escalatedToModel === generatorModel`. */
const isNudgedAtTop = (task: InProgressTask, generatorModel: string): boolean =>
  task.escalatedFromModel !== undefined &&
  task.escalatedFromModel === task.escalatedToModel &&
  task.escalatedToModel === generatorModel;

/** `task.bestOfNGranted` is never cleared once set, which makes the grant once-per-task. */
const resolveTopOfLadderRemedy = (props: DecideEscalationProps): EscalationDecision => {
  const bestOfN = props.bestOfNCandidates ?? 0;
  return bestOfN >= 2 && props.task.bestOfNGranted !== true
    ? { kind: 'best-of-n', n: bestOfN, model: props.generatorModel }
    : { kind: 'topped-out', model: props.generatorModel };
};

/** Pure decision. Budget is checked before the map so the operator sees the budget named when both fail. */
export const decideEscalation = (props: DecideEscalationProps): EscalationDecision => {
  if (!props.flagOn) return { kind: 'flag-off' };
  const maxAttempts = props.task.maxAttempts ?? props.fallbackMaxAttempts;
  const attemptsUsed = budgetedAttemptCount(props.task);
  if (attemptsUsed >= maxAttempts) return { kind: 'budget-exhausted', attemptsUsed, maxAttempts };
  const merged = mergeEscalationMap(props.userMap, props.generatorProvider);
  const next = merged[props.generatorModel];
  if (hasStrongerModelRung(merged, props.generatorModel, next)) {
    return { kind: 'escalate', from: props.generatorModel, to: next, ...computeEvaluatorEffortCarry(props) };
  }
  if (isNudgedAtTop(props.task, props.generatorModel)) return resolveTopOfLadderRemedy(props);
  const effortTarget = nextEffortRung(props.generatorProvider, props.generatorModel, props.generatorEffort);
  if (effortTarget !== undefined) {
    return {
      kind: 'escalate-effort',
      model: props.generatorModel,
      from: props.generatorEffort ?? 'default',
      to: effortTarget,
      ...computeEvaluatorEffortCarry(props),
    };
  }
  return { kind: 'nudge', currentModel: props.generatorModel };
};

/**
 * The model the generator spawns with: `task.escalatedToModel` when stamped, else the configured row.
 * The override is persisted, so it goes through the provider-guarded retired-model remap (a slug may
 * have retired since). The single resolution site for the spawn, the policy lookup and `meta.json`.
 */
export const effectiveGeneratorModel = (
  task: Pick<Task, 'escalatedToModel'>,
  configuredModel: string,
  provider: string | undefined
): string => {
  const override = task.escalatedToModel;
  if (override === undefined) return configuredModel;
  return provider === undefined ? override : remapRetiredModel(provider, override);
};

/** Per-task banner id: a re-fire overwrites in place; the next generator start's `banner-clear` releases it. */
export const escalationBannerId = (taskId: string): string => `model-escalation-${taskId}`;

export interface ApplyEscalationProps {
  readonly task: InProgressTask;
  readonly decision: EscalationDecision;
  readonly trigger: EscalationTrigger;
  /** Which plateau detector fired — forwarded onto `model-escalated` for the detector audit. */
  readonly plateauSource?: PlateauSource;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

/** One clock read and one banner slot for the whole announcement. */
interface AnnounceContext {
  readonly task: InProgressTask;
  readonly trigger: EscalationTrigger;
  readonly plateauSource?: PlateauSource | undefined;
  readonly eventBus: EventBus;
  readonly log: Logger;
  readonly bannerId: string;
  readonly now: IsoTimestamp;
  readonly cause: string;
}

const publishBanner = (ctx: AnnounceContext, tier: 'info' | 'warn', message: string, cause = ctx.cause): void => {
  ctx.eventBus.publish({ type: BANNER_SHOW_EVENT, id: ctx.bannerId, tier, message, cause, at: ctx.now });
};

const stampEvaluatorEffort = (
  task: InProgressTask,
  evaluator: EvaluatorEffortBump | undefined
): Result<InProgressTask, ValidationError> =>
  evaluator === undefined ? Result.ok(task) : recordTaskEvaluatorEffortEscalation(task, evaluator.to);

const evaluatorSuffix = (e: EvaluatorEffortBump | undefined): string =>
  e === undefined ? '' : `; evaluator effort: ${e.from} → ${e.to}`;

const evaluatorMeta = (e: EvaluatorEffortBump | undefined): LogMeta =>
  e === undefined ? {} : { evaluatorFrom: e.from, evaluatorTo: e.to };

const announceModelEscalation = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'escalate' }>
): Result<InProgressTask, ValidationError> => {
  const modelStamped = recordTaskEscalation(ctx.task, decision.from, decision.to);
  if (!modelStamped.ok) return Result.error(modelStamped.error);
  const stamped = stampEvaluatorEffort(modelStamped.value, decision.evaluator);
  if (!stamped.ok) return Result.error(stamped.error);
  ctx.eventBus.publish({
    type: 'model-escalated',
    taskId: String(ctx.task.id),
    attemptN: ctx.task.attempts.length,
    from: decision.from,
    to: decision.to,
    reason: ctx.trigger,
    ...(ctx.plateauSource !== undefined ? { plateauSource: ctx.plateauSource } : {}),
    at: ctx.now,
  });
  publishBanner(
    ctx,
    'info',
    `escalated generator model: ${decision.from} → ${decision.to}${evaluatorSuffix(decision.evaluator)}`
  );
  ctx.log.info(`escalating generator model: ${decision.from} → ${decision.to}`, {
    taskId: String(ctx.task.id),
    attemptN: ctx.task.attempts.length,
    from: decision.from,
    to: decision.to,
    reason: ctx.trigger,
    ...evaluatorMeta(decision.evaluator),
  });
  return stamped;
};

/** Leaves the escalation model fields untouched so the later nudge's same-model marker stays accurate. */
const announceEffortEscalation = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'escalate-effort' }>
): Result<InProgressTask, ValidationError> => {
  const effortStamped = recordTaskEffortEscalation(ctx.task, decision.to);
  if (!effortStamped.ok) return Result.error(effortStamped.error);
  const stamped = stampEvaluatorEffort(effortStamped.value, decision.evaluator);
  if (!stamped.ok) return Result.error(stamped.error);
  publishBanner(
    ctx,
    'info',
    `raised generator effort on '${decision.model}': ${decision.from} → ${decision.to}${evaluatorSuffix(decision.evaluator)}`
  );
  ctx.log.info(`raising generator effort on the same model: ${decision.from} → ${decision.to}`, {
    taskId: String(ctx.task.id),
    model: decision.model,
    from: decision.from,
    to: decision.to,
    reason: ctx.trigger,
    ...evaluatorMeta(decision.evaluator),
  });
  return stamped;
};

/** Stamps from === to, which arms the generator's change-of-approach directive and marks the nudge spent. */
const announceNudge = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'nudge' }>
): Result<InProgressTask, ValidationError> => {
  const stamped = recordTaskEscalation(ctx.task, decision.currentModel, decision.currentModel);
  if (!stamped.ok) return Result.error(stamped.error);
  publishBanner(
    ctx,
    'info',
    `${ctx.cause} on '${decision.currentModel}' (top of ladder) — retrying with a change-of-approach directive`
  );
  ctx.log.info('top-of-ladder nudge: retrying on the same model with a change-of-approach directive', {
    taskId: String(ctx.task.id),
    currentModel: decision.currentModel,
    reason: ctx.trigger,
  });
  return stamped;
};

const announceBestOfN = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'best-of-n' }>
): Result<InProgressTask, ValidationError> => {
  const stamped = recordTaskBestOfNGrant(ctx.task, decision.n);
  if (!stamped.ok) return Result.error(stamped.error);
  publishBanner(
    ctx,
    'info',
    `${ctx.cause} on '${decision.model}' (top of ladder) — next attempt samples ${String(decision.n)} candidates and selects by verification then judging`
  );
  ctx.log.info('best-of-N granted: next attempt samples N candidates, selected by verification then judging', {
    taskId: String(ctx.task.id),
    model: decision.model,
    n: decision.n,
    reason: ctx.trigger,
  });
  return stamped;
};

const announceToppedOut = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'topped-out' }>
): Result<InProgressTask, ValidationError> => {
  publishBanner(ctx, 'warn', 'ladder exhausted — keeping the work');
  ctx.log.warn(`ladder exhausted on '${decision.model}' (${ctx.cause}); keeping the work`, {
    taskId: String(ctx.task.id),
    model: decision.model,
    reason: ctx.trigger,
  });
  return Result.ok(ctx.task);
};

const announceBudgetExhausted = (
  ctx: AnnounceContext,
  decision: Extract<EscalationDecision, { kind: 'budget-exhausted' }>
): Result<InProgressTask, ValidationError> => {
  const budget = `attempts=${String(decision.attemptsUsed)}/${String(decision.maxAttempts)}`;
  publishBanner(ctx, 'warn', `${ctx.cause}, attempt budget exhausted — keeping the work`, budget);
  ctx.log.warn(
    `${ctx.cause} with attempt budget exhausted (attempts=${String(decision.attemptsUsed)}, maxAttempts=${String(decision.maxAttempts)}); keeping the work`,
    {
      taskId: String(ctx.task.id),
      attemptsUsed: decision.attemptsUsed,
      maxAttempts: decision.maxAttempts,
      reason: ctx.trigger,
    }
  );
  return Result.ok(ctx.task);
};

/**
 * Stamp the task for `decision` and narrate it (banner + log). Every stamp lands before any event, so
 * a failed stamp emits nothing. `flag-off` returns the task untouched.
 */
export const applyEscalation = (props: ApplyEscalationProps): Result<InProgressTask, ValidationError> => {
  const { task, decision, trigger } = props;
  const ctx: AnnounceContext = {
    task,
    trigger,
    plateauSource: props.plateauSource,
    eventBus: props.eventBus,
    log: props.logger.named('task.escalation-policy'),
    bannerId: escalationBannerId(String(task.id)),
    now: props.clock(),
    cause: triggerLabel(trigger),
  };

  switch (decision.kind) {
    case 'flag-off':
      return Result.ok(task);
    case 'escalate':
      return announceModelEscalation(ctx, decision);
    case 'escalate-effort':
      return announceEffortEscalation(ctx, decision);
    case 'nudge':
      return announceNudge(ctx, decision);
    case 'best-of-n':
      return announceBestOfN(ctx, decision);
    case 'topped-out':
      return announceToppedOut(ctx, decision);
    case 'budget-exhausted':
      return announceBudgetExhausted(ctx, decision);
  }
};
