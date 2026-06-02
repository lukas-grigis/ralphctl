import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import { applyEscalation, decideEscalation } from '@src/business/task/escalation-policy.ts';

/**
 * Settle a finished gen-eval loop. Maps the loop's terminal `GenEvalExit` to the
 * `AttemptWarning` + `RunTaskVerdict` that downstream `settle-attempt` consumes, then persists
 * the final task once via `taskRepo.update`.
 *
 * If the caller didn't determine a terminal `exit`, the use case synthesises a
 * `budget-exhausted` exit by reading the current harness config — that path covers the case
 * where the loop's `shouldContinue` predicate returned false at iteration N+1 (budget hit) and
 * none of the per-turn leaves wrote a terminal exit to ctx.
 *
 * Mapping rules:
 *   passed             → verdict 'passed',    no warning
 *   self-blocked       → verdict 'failed',    blockedReason set (settle-attempt picks it up)
 *   malformed          → verdict 'malformed', warning { kind: 'malformed', detail }
 *   plateau            → verdict 'failed',    warning { kind: 'plateau', dimensions }
 *   budget-exhausted   → verdict 'failed',    warning { kind: 'budget-exhausted', turnsUsed, turnBudget }
 */
export interface FinalizeGenEvalProps {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly exit?: GenEvalExit;
  /** Read when `exit` is undefined to synthesise a `budget-exhausted` outcome. */
  readonly turnsUsed: number;
  /**
   * Reads the live harness slice the use case needs:
   *   - `maxTurns`           — used to synthesise a budget-exhausted exit when the loop
   *                            terminated without writing a terminal exit.
   *   - `escalateOnPlateau`  — gates the model-escalation policy on plateau exits.
   *   - `escalationMap`      — user overrides merged over `DEFAULT_ESCALATION_MAP`.
   */
  readonly readConfig: () => Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
  }>;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
  /**
   * Generator model id the just-finished attempt ran on — read by the escalation policy so
   * the merged `escalationMap` can look up the next rung. The leaf passes either
   * `task.escalatedToModel` (when a prior escalation set the override) or the configured
   * `settings.ai.implement.generator.model`, mirroring the generator-leaf resolution order.
   */
  readonly generatorModel: string;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}

export interface FinalizeGenEvalOutput {
  readonly task: InProgressTask;
  readonly exit: GenEvalExit;
  readonly verdict: RunTaskVerdict;
  readonly warning?: AttemptWarning;
  readonly blockedReason?: string;
  /**
   * True when the escalation policy stamped `escalatedFromModel`/`escalatedToModel` on the
   * task. The caller propagates this onto ctx so settle-attempt fails the running attempt
   * (leaving the task `in_progress` for the next chain invocation, modulo `maxAttempts`)
   * instead of marking it `done`. Mutually exclusive with `blockedReason` — the policy emits
   * one or the other.
   */
  readonly shouldFailAttempt?: boolean;
}

const mapExit = (exit: GenEvalExit): { verdict: RunTaskVerdict; warning?: AttemptWarning; blockedReason?: string } => {
  switch (exit.kind) {
    case 'passed':
      return { verdict: 'passed' };
    case 'self-blocked':
      return { verdict: 'failed', blockedReason: exit.reason };
    case 'malformed':
      return { verdict: 'malformed', warning: { kind: 'malformed', detail: exit.detail } };
    case 'plateau':
      return { verdict: 'failed', warning: { kind: 'plateau', dimensions: exit.dimensions } };
    case 'budget-exhausted':
      return {
        verdict: 'failed',
        warning: { kind: 'budget-exhausted', turnsUsed: exit.turnsUsed, turnBudget: exit.turnBudget },
      };
  }
};

export const finalizeGenEvalUseCase = async (
  props: FinalizeGenEvalProps
): Promise<Result<FinalizeGenEvalOutput, InvalidStateError | NotFoundError | StorageError | ValidationError>> => {
  const log = props.logger.named('task.finalize-gen-eval');

  const cfg = await props.readConfig();
  let exit: GenEvalExit;
  if (props.exit !== undefined) {
    exit = props.exit;
  } else {
    exit = { kind: 'budget-exhausted', turnsUsed: props.turnsUsed, turnBudget: Math.max(1, cfg.maxTurns) };
  }

  log.debug(`finalizing gen-eval (${exit.kind})`, { taskId: props.task.id, exitKind: exit.kind });

  const mapped = mapExit(exit);

  // On a plateau exit, consult the model-escalation policy. The policy may stamp the task
  // with `escalatedFromModel`/`escalatedToModel` (escalation applied — task stays in_progress
  // for the next attempt), or it may surface a blocking reason (already-escalated, no map
  // rung above the current model, attempt-budget exhausted). When the operator opted out
  // (`escalateOnPlateau === false`) the policy is a no-op and the legacy plateau path
  // (done-with-warning) is preserved.
  let taskForPersist: InProgressTask = props.task;
  let blockedReason: string | undefined = mapped.blockedReason;
  let shouldFailAttempt = false;
  if (exit.kind === 'plateau') {
    const decision = decideEscalation({
      task: props.task,
      generatorModel: props.generatorModel,
      flagOn: cfg.escalateOnPlateau,
      userMap: cfg.escalationMap,
    });
    const applied = applyEscalation({
      task: props.task,
      decision,
      eventBus: props.eventBus,
      logger: props.logger,
      clock: props.clock,
    });
    if (!applied.ok) return Result.error(applied.error);
    taskForPersist = applied.value.task;
    if (applied.value.blockedReason !== undefined) blockedReason = applied.value.blockedReason;
    // Both a model escalation and a same-model nudge grant one more attempt: fail the running
    // attempt so the task stays in_progress and the outer loop re-enters (modulo maxAttempts).
    if (decision.kind === 'escalate' || decision.kind === 'nudge') shouldFailAttempt = true;
  }

  const persisted = await props.taskRepo.update(props.sprintId, taskForPersist);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: taskForPersist.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`gen-eval finalised → verdict=${mapped.verdict}`, {
    taskId: taskForPersist.id,
    exitKind: exit.kind,
    verdict: mapped.verdict,
    ...(mapped.warning !== undefined ? { warningKind: mapped.warning.kind } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  });
  return Result.ok({
    task: taskForPersist,
    exit,
    verdict: mapped.verdict,
    ...(mapped.warning !== undefined ? { warning: mapped.warning } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    ...(shouldFailAttempt ? { shouldFailAttempt: true } : {}),
  });
};
