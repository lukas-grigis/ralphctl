import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { isRecoverableTurnError } from '@src/business/task/turn-error-policy.ts';

/**
 * Run one generator turn of the gen-eval loop. Drives a single AI implement call, inspects the
 * harness signals it produced, and decides whether the task can continue to the evaluator turn
 * or has terminated early because the generator self-blocked.
 *
 * Decisions owned by this use case:
 *  - Did the generator self-block? `task-blocked` signal → terminal exit, no verification recorded.
 *  - Otherwise, stamp the running attempt's structural verification marker so the evaluator
 *    turn can settle the task as `verified` if it passes (the AI's prose used to be persisted
 *    here; it isn't anymore — signals.json on disk is the audit trail).
 *
 * The actual AI call + signal extraction are integration concerns supplied as function-shape
 * deps so the use case stays integration-agnostic and easy to test. The leaf is responsible
 * for reading the provider's `signalsFile` and publishing each signal onto the harness-signal
 * channel before calling this use case.
 */
export type GeneratorTurnExit = { readonly kind: 'self-blocked' | 'crashed'; readonly reason: string };

export interface RunGeneratorTurnProps {
  readonly task: InProgressTask;
  /**
   * Drive one AI implement call. Returns the parsed signals (already extracted from
   * `provider.generate`'s signalsFile by the leaf) so this use case stays free of file I/O.
   */
  readonly callImplement: (task: InProgressTask) => Promise<Result<readonly HarnessSignal[], DomainError>>;
  readonly logger: Logger;
}

export interface ProposedCommitMessage {
  readonly subject: string;
  readonly body?: string;
}

export interface RunGeneratorTurnOutput {
  readonly task: InProgressTask;
  /** Set when the generator self-blocked; otherwise undefined and the loop continues to the evaluator. */
  readonly exit?: GeneratorTurnExit;
  /**
   * Latest commit-message signal emitted by this turn, if any. Threaded onto the chain ctx by
   * the generator leaf so the commit-task leaf can use it as the commit message. Multiple
   * commit-message tags in a single turn → the last one wins (consistent with v1's "latest
   * generator intent" semantics for repeated signals).
   */
  readonly proposedCommitMessage?: ProposedCommitMessage;
}

const findTaskBlocked = (signals: readonly HarnessSignal[]): string | undefined =>
  signals.find((s): s is HarnessSignal & { type: 'task-blocked' } => s.type === 'task-blocked')?.reason;

const findLatestCommitMessage = (signals: readonly HarnessSignal[]): ProposedCommitMessage | undefined => {
  const matches = signals.filter((s): s is HarnessSignal & { type: 'commit-message' } => s.type === 'commit-message');
  const last = matches[matches.length - 1];
  if (last === undefined) return undefined;
  return last.body !== undefined ? { subject: last.subject, body: last.body } : { subject: last.subject };
};

export const runGeneratorTurnUseCase = async (
  props: RunGeneratorTurnProps
): Promise<Result<RunGeneratorTurnOutput, DomainError>> => {
  const log = props.logger.named('task.generator-turn');
  log.debug('running generator turn', { taskId: props.task.id });

  const signalsResult = await props.callImplement(props.task);
  if (!signalsResult.ok) {
    const err = signalsResult.error;
    // Fatal errors (user abort, rate-limit-after-retries) must abort the whole run — propagate.
    // Everything else is recoverable, but splits two ways by error TYPE:
    //  - a `ProcessCrash` (watchdog kill / spawn crash / non-zero exit with no signals.json) is a
    //    TRANSIENT process death → a `crashed` exit, which finalize retries within maxAttempts
    //    (then blocks at the cap) instead of terminally blocking after one attempt.
    //  - anything else is a genuine signals-contract failure (codex/copilot wrote the wrong shape,
    //    wrong place, or nothing) → a `self-blocked` exit that blocks THIS task so it surfaces and
    //    re-runs next launch, without taking down every remaining task.
    // The error message rides the exit reason so the operator / progress.md shows WHY the turn failed.
    if (!isRecoverableTurnError(err)) {
      log.error('implement call failed (fatal — propagating)', { taskId: props.task.id, error: err.message });
      return Result.error(err);
    }
    if (err.code === ErrorCode.ProcessCrash) {
      log.warn('AI process was killed before producing signals.json — retrying attempt', {
        taskId: props.task.id,
        error: err.message,
      });
      return Result.ok({
        task: props.task,
        exit: { kind: 'crashed', reason: `AI process was killed before producing signals.json: ${err.message}` },
      });
    }
    log.warn('generator did not produce a valid signals.json — blocking task', {
      taskId: props.task.id,
      error: err.message,
    });
    return Result.ok({
      task: props.task,
      exit: { kind: 'self-blocked', reason: `generator did not produce a valid signals.json: ${err.message}` },
    });
  }
  const signals = signalsResult.value;

  const proposedCommitMessage = findLatestCommitMessage(signals);

  const blockedReason = findTaskBlocked(signals);
  if (blockedReason !== undefined) {
    log.info(`generator self-blocked: ${blockedReason}`, { taskId: props.task.id, reason: blockedReason });
    // A blocked turn doesn't commit — propagate the message anyway so a future non-blocked
    // turn doesn't lose context, but the harness's commit-task leaf will no-op on a clean tree.
    return Result.ok({
      task: props.task,
      exit: { kind: 'self-blocked', reason: blockedReason },
      ...(proposedCommitMessage !== undefined ? { proposedCommitMessage } : {}),
    });
  }

  const recorded = recordRunningAttemptVerification(props.task);
  if (!recorded.ok) {
    log.error('cannot record verification on attempt', {
      taskId: props.task.id,
      error: recorded.error.message,
    });
    return Result.error(recorded.error);
  }

  log.debug('generator produced verification', { taskId: recorded.value.id });
  return Result.ok({
    task: recorded.value,
    ...(proposedCommitMessage !== undefined ? { proposedCommitMessage } : {}),
  });
};
