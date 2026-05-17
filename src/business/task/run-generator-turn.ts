import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type InProgressTask, recordRunningAttemptVerification } from '@src/domain/entity/task.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';

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
 * for reading the provider's `signalsFile` and forwarding signals to the harness sink before
 * calling this use case.
 */
export type GeneratorTurnExit = { readonly kind: 'self-blocked'; readonly reason: string };

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
    log.error('implement call failed', { taskId: props.task.id, error: signalsResult.error.message });
    return Result.error(signalsResult.error);
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
