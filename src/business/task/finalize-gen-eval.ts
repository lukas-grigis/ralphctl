import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { GenEvalExit, RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';

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
  readonly readConfig: () => Promise<{ readonly maxTurns: number }>;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

export interface FinalizeGenEvalOutput {
  readonly task: InProgressTask;
  readonly exit: GenEvalExit;
  readonly verdict: RunTaskVerdict;
  readonly warning?: AttemptWarning;
  readonly blockedReason?: string;
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

  let exit: GenEvalExit;
  if (props.exit !== undefined) {
    exit = props.exit;
  } else {
    const cfg = await props.readConfig();
    exit = { kind: 'budget-exhausted', turnsUsed: props.turnsUsed, turnBudget: Math.max(1, cfg.maxTurns) };
  }

  log.debug(`finalizing gen-eval (${exit.kind})`, { taskId: props.task.id, exitKind: exit.kind });

  const mapped = mapExit(exit);

  const persisted = await props.taskRepo.update(props.sprintId, props.task);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: props.task.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`gen-eval finalised → verdict=${mapped.verdict}`, {
    taskId: props.task.id,
    exitKind: exit.kind,
    verdict: mapped.verdict,
    ...(mapped.warning !== undefined ? { warningKind: mapped.warning.kind } : {}),
  });
  return Result.ok({
    task: props.task,
    exit,
    verdict: mapped.verdict,
    ...(mapped.warning !== undefined ? { warning: mapped.warning } : {}),
    ...(mapped.blockedReason !== undefined ? { blockedReason: mapped.blockedReason } : {}),
  });
};
