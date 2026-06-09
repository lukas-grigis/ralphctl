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
import { applyEscalation, decideEscalation, type EscalationTrigger } from '@src/business/task/escalation-policy.ts';

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
 * Mapping rules (the warning/verdict half is fixed per exit kind; the retry half — whether the
 * attempt fails so the outer loop re-enters — is gated by the escalation policy / attempt budget):
 *   passed             → verdict 'passed',    no warning,                       never retries
 *   self-blocked       → verdict 'failed',    blockedReason set (settle blocks), never retries
 *   plateau            → verdict 'failed',    warning { kind: 'plateau' },       escalation policy
 *   budget-exhausted   → verdict 'failed',    warning { kind: 'budget-exhausted' }, escalation policy
 *   malformed          → verdict 'malformed', warning { kind: 'malformed' },     plain same-model retry
 *
 * `plateau` and `budget-exhausted` (real or synthesized) consult {@link decideEscalation}: while
 * the attempt budget remains they climb the model ladder (or nudge at the top) and set
 * `shouldFailAttempt` so the outer attempt loop re-enters; once the ladder tops out OR the attempt
 * budget is exhausted they keep the work (done-with-warning). `malformed` is the evaluator's
 * failure, not the generator's — it does NOT burn a ladder rung; it gets a plain same-model
 * fresh-attempt retry while budget remains, falling back to done-with-warning when exhausted.
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
   *   - `escalateOnPlateau`  — gates the model-escalation policy. Despite the name (kept for
   *                            backward compatibility) it now gates ALL failure-driven escalation:
   *                            plateau AND budget-exhausted exits.
   *   - `escalationMap`      — user overrides merged over `DEFAULT_ESCALATION_MAP`.
   *   - `maxAttempts`        — effective attempt budget when `task.maxAttempts` is unset (legacy
   *                            tasks); wired from `settings.harness.maxAttempts`.
   */
  readonly readConfig: () => Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
    readonly maxAttempts: number;
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
   * True when the just-finished attempt should fail (leaving the task `in_progress` for the next
   * chain invocation, modulo the effective `maxAttempts`) instead of marking it `done`. Set on two
   * paths: the escalation policy stamping `escalatedFromModel`/`escalatedToModel` (an escalate or
   * top-of-ladder nudge after a plateau / budget-exhausted exit), and the plain same-model
   * malformed retry (which fails the attempt WITHOUT stamping the escalation fields). The caller
   * propagates this onto ctx so settle-attempt fails the running attempt. Neither path sets
   * `blockedReason` — a failure-driven retry never blocks — so on this path only
   * `shouldFailAttempt` is produced; the settle-attempt precedence (`blockedReason` wins over
   * `shouldFailAttempt`) is a guard for the unrelated self-blocked path and does not engage here.
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
      return { verdict: 'failed' };
    case 'budget-exhausted':
      return {
        verdict: 'failed',
        warning: { kind: 'budget-exhausted', turnsUsed: exit.turnsUsed, turnBudget: exit.turnBudget },
      };
  }
};

/**
 * Exits whose remedy is a generator-model escalation — the model ladder genuinely targets a
 * generator weakness. `plateau` (the generator stalled producing the same failed dimensions) and
 * `budget-exhausted` (the generator never reached a terminal verdict in the turn budget — real or
 * the synthesized exit when no leaf wrote one) both qualify. `malformed` is deliberately excluded:
 * it is the EVALUATOR's failure (no parseable terminal verdict), so escalating the GENERATOR's
 * model would burn a ladder rung on the wrong role — it is routed to a plain same-model retry by
 * the caller. `passed` / `self-blocked` are terminal and never reach this predicate's branch.
 */
const isEscalatableExit = (exit: GenEvalExit): exit is Extract<GenEvalExit, { kind: 'plateau' | 'budget-exhausted' }> =>
  exit.kind === 'plateau' || exit.kind === 'budget-exhausted';

interface Remedy {
  readonly task: InProgressTask;
  readonly blockedReason?: string;
  readonly shouldFailAttempt: boolean;
}

/**
 * Resolve the retry remedy for an escalatable exit (plateau / budget-exhausted). Consults the
 * model-escalation policy: escalate / top-of-ladder nudge grant one more attempt (stamp the
 * model fields + set `shouldFailAttempt` so the outer loop re-enters), while topped-out /
 * budget-exhausted / flag-off keep the work (done-with-warning).
 */
const resolveEscalatableRemedy = (
  exit: Extract<GenEvalExit, { kind: 'plateau' | 'budget-exhausted' }>,
  props: FinalizeGenEvalProps,
  cfg: {
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
    readonly maxAttempts: number;
  }
): Result<Remedy, ValidationError> => {
  const trigger: EscalationTrigger = exit.kind;
  const decision = decideEscalation({
    task: props.task,
    generatorModel: props.generatorModel,
    flagOn: cfg.escalateOnPlateau,
    userMap: cfg.escalationMap,
    fallbackMaxAttempts: cfg.maxAttempts,
  });
  const applied = applyEscalation({
    task: props.task,
    decision,
    trigger,
    eventBus: props.eventBus,
    logger: props.logger,
    clock: props.clock,
  });
  if (!applied.ok) return Result.error(applied.error);
  // Both a model escalation and a same-model nudge grant one more attempt: fail the running attempt
  // so the task stays in_progress and the outer loop re-enters (modulo the effective maxAttempts).
  const shouldFailAttempt = decision.kind === 'escalate' || decision.kind === 'nudge';
  return Result.ok({
    task: applied.value.task,
    ...(applied.value.blockedReason !== undefined ? { blockedReason: applied.value.blockedReason } : {}),
    shouldFailAttempt,
  });
};

/**
 * Resolve the retry remedy for a malformed exit — the evaluator's failure, not the generator's, so
 * NO ladder rung is burned. Grant a plain same-model fresh-attempt retry while the attempt budget
 * remains (gated by the same flag so an opted-out operator keeps the legacy done-with-warning
 * path); once the budget is exhausted, fall back to done-with-warning. Never stamps the model
 * fields.
 */
const resolveMalformedRemedy = (
  props: FinalizeGenEvalProps,
  cfg: { readonly escalateOnPlateau: boolean; readonly maxAttempts: number },
  log: Logger
): Remedy => {
  const effectiveMaxAttempts = props.task.maxAttempts ?? cfg.maxAttempts;
  const budgetRemains = props.task.attempts.length < effectiveMaxAttempts;
  const shouldFailAttempt = cfg.escalateOnPlateau && budgetRemains;
  log.info(
    shouldFailAttempt
      ? 'malformed exit: retrying on the same model (no escalation)'
      : 'malformed exit: keeping the work (done-with-warning)',
    {
      taskId: props.task.id,
      attemptsUsed: props.task.attempts.length,
      maxAttempts: effectiveMaxAttempts,
      flagOn: cfg.escalateOnPlateau,
    }
  );
  return { task: props.task, shouldFailAttempt };
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

  // Resolve the retry remedy from the exit kind. `plateau` / `budget-exhausted` (real + synthesized)
  // consult the model-escalation policy; `malformed` gets a plain same-model retry (no ladder rung);
  // `passed` / `self-blocked` have no remedy (settle-attempt handles them directly).
  let remedy: Remedy = {
    task: props.task,
    ...(mapped.blockedReason !== undefined ? { blockedReason: mapped.blockedReason } : {}),
    shouldFailAttempt: false,
  };
  if (isEscalatableExit(exit)) {
    const resolved = resolveEscalatableRemedy(exit, props, cfg);
    if (!resolved.ok) return Result.error(resolved.error);
    remedy = resolved.value;
  } else if (exit.kind === 'malformed') {
    remedy = resolveMalformedRemedy(props, cfg, log);
  }

  const taskForPersist: InProgressTask = remedy.task;
  const blockedReason: string | undefined = remedy.blockedReason ?? mapped.blockedReason;
  const shouldFailAttempt = remedy.shouldFailAttempt;

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
