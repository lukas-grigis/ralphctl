import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { HarnessSignal, TaskBlockedSignal, TaskBlockerClass } from '@src/domain/signal.ts';
import { isRecoverableTurnError } from '@src/business/task/turn-error-policy.ts';
import { abortCauseFromError } from '@src/business/task/abort-cause-from-error.ts';

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
export type GeneratorTurnExit = {
  readonly kind: 'self-blocked' | 'crashed';
  readonly reason: string;
  /**
   * Crash forensics for a `crashed` exit — mapped from the `ProcessCrashError` that killed the
   * turn (see `abortCauseFromError`). Rides the exit onto ctx so the settle that eventually
   * blocks the task attributes the aborted attempt instead of recording `unknown`. Never set on
   * a `self-blocked` exit: nothing was killed there.
   */
  readonly abortCause?: AbortCause;
  readonly signalOrExitCode?: string | number;
  /**
   * The generator's own structured triage from a `task-blocked` signal — see
   * {@link TaskBlockedSignal.blockerClass} / `.question` / `.whatUnblocksMe` in `domain/signal.ts`.
   * Set only on a `self-blocked` exit produced from a REAL signal that supplied them (never on the
   * synthetic self-block this use case constructs for a signals-contract failure, and never on
   * `crashed` — nothing was killed there to triage). Carried verbatim so the settle path that
   * blocks the task can persist them onto `BlockedTask` instead of collapsing to `reason` alone.
   */
  readonly blockerClass?: TaskBlockerClass;
  readonly question?: string;
  readonly whatUnblocksMe?: string;
};

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

/**
 * Find the `task-blocked` signal, if any — returning the WHOLE signal (never only `.reason`) so
 * the caller can carry the generator's structured triage (`blockerClass` / `question` /
 * `whatUnblocksMe`) onto the {@link GeneratorTurnExit} instead of discarding it. All three are
 * optional on the signal; a legacy or minimal emission still blocks the task via `reason` alone.
 */
const findTaskBlocked = (signals: readonly HarnessSignal[]): TaskBlockedSignal | undefined =>
  signals.find((s): s is TaskBlockedSignal => s.type === 'task-blocked');

/**
 * The generator's structured triage off a `task-blocked` signal — what KIND of blocker it hit, the
 * question it needs answered, and what would unblock it. Named so the carry can be threaded whole
 * (chain ctx → settle → persisted task → operator surfaces) instead of three fields being spread by
 * hand at each hop, which is how the triage came to be collected and then dropped once already.
 *
 * @public
 */
export type BlockTriageCarry = Pick<GeneratorTurnExit, 'blockerClass' | 'question' | 'whatUnblocksMe'>;

/**
 * Project the triage off a signal, ready to spread onto a `self-blocked` {@link GeneratorTurnExit}
 * (or a log line) — each field present only when the signal supplied it. Split out so the caller's
 * own branching doesn't grow with every field.
 */
const blockedTriageCarry = (signal: TaskBlockedSignal): BlockTriageCarry => ({
  ...(signal.blockerClass !== undefined ? { blockerClass: signal.blockerClass } : {}),
  ...(signal.question !== undefined ? { question: signal.question } : {}),
  ...(signal.whatUnblocksMe !== undefined ? { whatUnblocksMe: signal.whatUnblocksMe } : {}),
});

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
        exit: {
          kind: 'crashed',
          reason: `AI process was killed before producing signals.json: ${err.message}`,
          ...abortCauseFromError(err),
        },
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

  const blockedSignal = findTaskBlocked(signals);
  if (blockedSignal !== undefined) {
    log.info(`generator self-blocked: ${blockedSignal.reason}`, {
      taskId: props.task.id,
      reason: blockedSignal.reason,
      ...blockedTriageCarry(blockedSignal),
    });
    // A blocked turn doesn't commit — propagate the message anyway so a future non-blocked
    // turn doesn't lose context, but the harness's commit-task leaf will no-op on a clean tree.
    // The structured triage fields (blockerClass / question / whatUnblocksMe) ride the exit
    // verbatim so the settle path can persist them onto the task instead of collapsing to
    // `reason` alone — see `GeneratorTurnExit`'s doc comment.
    return Result.ok({
      task: props.task,
      exit: { kind: 'self-blocked', reason: blockedSignal.reason, ...blockedTriageCarry(blockedSignal) },
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
