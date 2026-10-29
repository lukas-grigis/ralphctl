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
import {
  applyEscalation,
  decideEscalation,
  type DecideEscalationProps,
  type EscalationTrigger,
} from '@src/business/task/escalation-policy.ts';
import { budgetedAttemptCount, clearRunningAttemptPlateauWarning } from '@src/domain/entity/task-attempts.ts';

/** {@link GenEvalExit} kind for a loop whose turn budget ran out without a terminal verdict. */
const BUDGET_EXHAUSTED_EXIT = 'budget-exhausted';

/** The live `settings.harness` slice finalize reads. */
interface EscalationConfig {
  /** Synthesises the `budget-exhausted` exit when no leaf wrote a terminal one. */
  readonly maxTurns: number;
  /** Gates ALL failure-driven escalation (plateau and budget-exhausted) despite its name. */
  readonly escalateOnPlateau: boolean;
  readonly escalationMap: Readonly<Record<string, string>>;
  /** Budget for legacy tasks without `task.maxAttempts`. */
  readonly maxAttempts: number;
  readonly bestOfNCandidates?: number | undefined;
}

/**
 * Settle a finished gen-eval loop: map the terminal exit to the verdict + warning settle-attempt
 * consumes, decide the retry remedy, and persist the task once. A missing `exit` is synthesised as
 * `budget-exhausted`.
 *
 *   passed            → 'passed',    no warning,              never retries
 *   self-blocked      → 'failed',    blockedReason,           never retries
 *   crashed           → 'failed',    crashed warning,         retries within maxAttempts (no ladder rung)
 *   plateau           → 'failed',    plateau warning,         escalation policy
 *   budget-exhausted  → 'failed',    budget warning,          escalation policy
 *   malformed         → 'malformed', malformed warning,       plain same-model retry (evaluator's fault)
 */
export interface FinalizeGenEvalProps extends Pick<
  DecideEscalationProps,
  | 'generatorModel'
  | 'generatorProvider'
  | 'generatorEffort'
  | 'evaluatorProvider'
  | 'evaluatorModel'
  | 'evaluatorEffort'
> {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly exit?: GenEvalExit;
  /** Read when `exit` is undefined to synthesise a `budget-exhausted` outcome. */
  readonly turnsUsed: number;
  readonly readConfig: () => Promise<EscalationConfig>;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}

export interface FinalizeGenEvalOutput {
  readonly task: InProgressTask;
  readonly exit: GenEvalExit;
  readonly verdict: RunTaskVerdict;
  readonly warning?: AttemptWarning;
  readonly blockedReason?: string;
  /** Fail the attempt so the task stays `in_progress` for a retry; see settle-attempt's PRECEDENCE note. */
  readonly shouldFailAttempt?: boolean;
}

const mapExit = (exit: GenEvalExit): { verdict: RunTaskVerdict; warning?: AttemptWarning; blockedReason?: string } => {
  switch (exit.kind) {
    case 'passed':
      return { verdict: 'passed' };
    case 'self-blocked':
      return { verdict: 'failed', blockedReason: exit.reason };
    case 'crashed':
      return { verdict: 'failed', warning: { kind: 'crashed', detail: exit.reason } };
    case 'malformed':
      return { verdict: 'malformed', warning: { kind: 'malformed', detail: exit.detail } };
    case 'plateau':
      return {
        verdict: 'failed',
        warning: {
          kind: 'plateau',
          dimensions: exit.dimensions,
          ...(exit.source !== undefined ? { source: exit.source } : {}),
        },
      };
    case BUDGET_EXHAUSTED_EXIT:
      return {
        verdict: 'failed',
        warning: { kind: BUDGET_EXHAUSTED_EXIT, turnsUsed: exit.turnsUsed, turnBudget: exit.turnBudget },
      };
  }
};

/** `malformed` is excluded: it is the evaluator's failure, so a generator ladder rung would target the wrong role. */
const isEscalatableExit = (exit: GenEvalExit): exit is Extract<GenEvalExit, { kind: 'plateau' | 'budget-exhausted' }> =>
  exit.kind === 'plateau' || exit.kind === BUDGET_EXHAUSTED_EXIT;

interface Remedy {
  readonly task: InProgressTask;
  readonly blockedReason?: string;
  readonly shouldFailAttempt: boolean;
}

const resolveEscalatableRemedy = (
  exit: Extract<GenEvalExit, { kind: 'plateau' | 'budget-exhausted' }>,
  props: FinalizeGenEvalProps,
  cfg: EscalationConfig
): Result<Remedy, ValidationError> => {
  const trigger: EscalationTrigger = exit.kind;
  const decision = decideEscalation({
    ...props,
    flagOn: cfg.escalateOnPlateau,
    userMap: cfg.escalationMap,
    fallbackMaxAttempts: cfg.maxAttempts,
    bestOfNCandidates: cfg.bestOfNCandidates,
  });
  const applied = applyEscalation({
    task: props.task,
    decision,
    trigger,
    ...(exit.kind === 'plateau' && exit.source !== undefined ? { plateauSource: exit.source } : {}),
    eventBus: props.eventBus,
    logger: props.logger,
    clock: props.clock,
  });
  if (!applied.ok) return Result.error(applied.error);
  const shouldFailAttempt =
    decision.kind === 'escalate' ||
    decision.kind === 'escalate-effort' ||
    decision.kind === 'nudge' ||
    decision.kind === 'best-of-n';
  return Result.ok({ task: applied.value, shouldFailAttempt });
};

/** Same-model retry while budget remains (same flag gate), else done-with-warning. Never burns a rung. */
const resolveMalformedRemedy = (
  props: FinalizeGenEvalProps,
  cfg: Pick<EscalationConfig, 'escalateOnPlateau' | 'maxAttempts'>,
  log: Logger
): Remedy => {
  const effectiveMaxAttempts = props.task.maxAttempts ?? cfg.maxAttempts;
  const budgetRemains = budgetedAttemptCount(props.task) < effectiveMaxAttempts;
  const shouldFailAttempt = cfg.escalateOnPlateau && budgetRemains;
  log.info(
    shouldFailAttempt
      ? 'malformed exit: retrying on the same model (no escalation)'
      : 'malformed exit: keeping the work (done-with-warning)',
    {
      taskId: props.task.id,
      attemptsUsed: budgetedAttemptCount(props.task),
      maxAttempts: effectiveMaxAttempts,
      flagOn: cfg.escalateOnPlateau,
    }
  );
  return { task: props.task, shouldFailAttempt };
};

/**
 * A crash is not a quality failure: retry regardless of `escalateOnPlateau`, with no ladder rung.
 * `failCurrentAttempt` blocks at the cap only when `task.maxAttempts` is set, so a legacy task would
 * retry forever — block it here once it reaches the fallback budget.
 */
const resolveCrashedRemedy = (props: FinalizeGenEvalProps, cfg: Pick<EscalationConfig, 'maxAttempts'>): Remedy => {
  const legacyBudgetExhausted =
    props.task.maxAttempts === undefined && budgetedAttemptCount(props.task) >= cfg.maxAttempts;
  return legacyBudgetExhausted
    ? {
        task: props.task,
        shouldFailAttempt: false,
        blockedReason: 'AI process repeatedly crashed; attempt budget exhausted',
      }
    : { task: props.task, shouldFailAttempt: true };
};

export const finalizeGenEvalUseCase = async (
  props: FinalizeGenEvalProps
): Promise<Result<FinalizeGenEvalOutput, InvalidStateError | NotFoundError | StorageError | ValidationError>> => {
  const log = props.logger.named('task.finalize-gen-eval');

  const cfg = await props.readConfig();
  const exit: GenEvalExit = props.exit ?? {
    kind: BUDGET_EXHAUSTED_EXIT,
    turnsUsed: props.turnsUsed,
    turnBudget: Math.max(1, cfg.maxTurns),
  };

  log.debug(`finalizing gen-eval (${exit.kind})`, { taskId: props.task.id, exitKind: exit.kind });

  const mapped = mapExit(exit);

  // A clean pass strips a softened-plateau warning stamped mid-loop: the grace round worked.
  let remedy: Remedy = {
    task: exit.kind === 'passed' ? clearRunningAttemptPlateauWarning(props.task) : props.task,
    ...(mapped.blockedReason !== undefined ? { blockedReason: mapped.blockedReason } : {}),
    shouldFailAttempt: false,
  };
  if (isEscalatableExit(exit)) {
    const resolved = resolveEscalatableRemedy(exit, props, cfg);
    if (!resolved.ok) return Result.error(resolved.error);
    remedy = resolved.value;
  } else if (exit.kind === 'malformed') {
    remedy = resolveMalformedRemedy(props, cfg, log);
  } else if (exit.kind === 'crashed') {
    remedy = resolveCrashedRemedy(props, cfg);
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
