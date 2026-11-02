import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  type AbortCause,
  type AbortMetadata,
  type AttemptUsage,
  type AttemptWarning,
  recordAttemptUsage,
} from '@src/domain/entity/attempt.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, DoneTask, FaultSide, InProgressTask } from '@src/domain/entity/task.ts';
import { publishTaskBlocked } from '@src/business/task/publish-task-blocked.ts';
import type { RunTaskVerdict } from '@src/business/task/gen-eval-exit.ts';
import { blockedTriageCarry } from '@src/business/task/run-generator-turn.ts';
import { updateRunningAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt, markTaskDone } from '@src/domain/entity/task-settle.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import { classifyBlock, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { CriterionVerdict, TaskBlockerClass } from '@src/domain/signal.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Settle a running attempt at the end of one gen-eval loop:
 *
 *   `shouldFailAttempt`      → fail the attempt; the task stays `in_progress` for the retry
 *   `blockedReason` set      → attempt aborted, task `blocked`
 *   otherwise (any verdict)  → task `done`, carrying the structured `warning` when there is one
 *
 * `verdict` is for logging and audit — `finalize-gen-eval` already mapped each exit onto the fields above.
 */
export interface SettleAttemptProps {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly verdict: RunTaskVerdict;
  readonly blockedReason?: string;
  readonly warning?: AttemptWarning;
  /** Escalation granted a retry; at the attempt cap `failCurrentAttempt` blocks the task instead. */
  readonly shouldFailAttempt?: boolean;
  /** This round's per-criterion verdicts, folded over the task's `criteriaVerdicts`. */
  readonly criteria?: readonly CriterionVerdict[];
  /** Block path only: crash forensics. Absent → `self-blocked` (nothing was killed). */
  readonly abortCause?: AbortCause;
  readonly signalOrExitCode?: string | number;
  /** Block path only: the generator's own triage from its `task-blocked` signal. */
  readonly blockerClass?: TaskBlockerClass;
  readonly question?: string;
  readonly whatUnblocksMe?: string;
  /** Stamped before the terminal transition — the settle point is the only place usage meets its attempt. */
  readonly usage?: AttemptUsage;
  /** The session the attempt's last generator turn ran on — stamped as `Attempt.sessionId`. */
  readonly generatorSessionId?: string;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /** Receives `TaskBlockedEvent` once a block is persisted. */
  readonly eventBus?: EventBus;
  /**
   * Settle refuses `done` when this returns `true`: a dirty tree means commit-task skipped or the AI
   * wrote files after committing, so "done" would lie about what landed in git.
   */
  readonly hasUncommittedChanges?: () => Promise<Result<boolean, StorageError>>;
  /** Used only in error messages so the operator knows which worktree to inspect. */
  readonly cwd?: AbsolutePath;
}

export type SettleAttemptOutput = DoneTask | InProgressTask | BlockedTask;

const abortMetaFor = (props: Pick<SettleAttemptProps, 'abortCause' | 'signalOrExitCode'>): AbortMetadata => ({
  abortCause: props.abortCause ?? 'self-blocked',
  ...(props.signalOrExitCode !== undefined ? { signalOrExitCode: props.signalOrExitCode } : {}),
});

const settleLogMeta = (props: SettleAttemptProps): LogMeta => ({
  taskId: props.task.id,
  verdict: props.verdict,
  ...(props.blockedReason !== undefined ? { blockedReason: props.blockedReason } : {}),
  ...(props.warning !== undefined ? { warning: props.warning.kind } : {}),
  ...(props.abortCause !== undefined ? { abortCause: props.abortCause } : {}),
});

/**
 * Backfill `{ blockCause, faultSide }` when `failCurrentAttempt`'s attempt-cap transition produced an
 * unclassified `BlockedTask`. A no-op for non-blocked or already-classified results.
 */
const classifyIfBlocked = (
  result: Result<SettleAttemptOutput, InvalidStateError>,
  hints: { readonly abortCause?: AbortCause | undefined; readonly faultSide?: FaultSide | undefined }
): Result<SettleAttemptOutput, InvalidStateError> => {
  if (!result.ok) return result;
  const task = result.value;
  if (task.status !== 'blocked' || task.blockCause !== undefined) return result;
  return Result.ok({ ...task, ...classifyBlock(task.blockedReason, task.blockKind, hints) });
};

/** The one in-process settle that closes an attempt as `aborted`, classified from the real block reason. */
const settleAsBlocked = (
  task: InProgressTask,
  blockedReason: string,
  now: IsoTimestamp,
  hints: Pick<SettleAttemptProps, 'abortCause' | 'signalOrExitCode' | 'blockerClass' | 'question' | 'whatUnblocksMe'>
): Result<SettleAttemptOutput, InvalidStateError> => {
  const aborted = failCurrentAttempt(task, now, 'aborted', abortMetaFor(hints));
  if (!aborted.ok) return Result.error(aborted.error);
  // This path is never fold-conflict / worktree-setup / upstream / operator-cancel (those settle
  // elsewhere), so the generic `unknown` default would be wrong.
  const classification = classifyBlock(blockedReason, 'own', {
    abortCause: hints.abortCause,
    ownDefault: 'generator-self-block',
  });
  if (aborted.value.status === 'blocked') {
    return Result.ok({
      ...aborted.value,
      blockedReason,
      blockKind: 'own',
      ...classification,
      ...blockedTriageCarry(hints),
    });
  }
  const marked = markTaskBlocked(aborted.value, blockedReason, 'own', classification);
  if (!marked.ok) return marked;
  return Result.ok({ ...marked.value, ...blockedTriageCarry(hints) });
};

const settleTask = (props: SettleAttemptProps, now: IsoTimestamp): Result<SettleAttemptOutput, InvalidStateError> => {
  // Stamp FIRST: every branch below turns the running attempt terminal.
  const stamped = updateRunningAttempt(props.task, (a) => ({
    ...recordAttemptUsage(a, props.usage ?? {}),
    ...(props.generatorSessionId !== undefined ? { sessionId: props.generatorSessionId } : {}),
    ...(props.warning !== undefined ? { warning: props.warning } : {}),
  }));
  if (!stamped.ok) return Result.error(stamped.error);
  const task = stamped.value;
  // PRECEDENCE: a granted retry outranks a block reason. finalize-gen-eval never sets both — they
  // co-occur only when a LATER leaf (red post-task-verify) stamped the block after finalize granted
  // the retry, and a red verify is exactly what a stronger-model retry targets. The red work never
  // lands: the commit guard keys on the block reason and the retry-diff quarantine stashes it. Once
  // the budget exhausts, finalize stops granting retries and the same red verify blocks the task.
  if (props.shouldFailAttempt === true) {
    const malformed = props.verdict === 'malformed';
    const result = failCurrentAttempt(task, now, malformed ? 'malformed' : 'failed');
    // A block here is always attempt-budget exhaustion; a repeatedly malformed evaluator is a grader fault.
    return classifyIfBlocked(result, {
      abortCause: props.abortCause,
      ...(malformed ? { faultSide: 'grader' } : {}),
    });
  }
  if (props.blockedReason !== undefined) {
    return settleAsBlocked(task, props.blockedReason, now, props);
  }
  return markTaskDone(task, now);
};

/** Refuse `done` on a dirty tree. The block and retry paths are exempt: they may leave changes behind. */
const dirtyTreeRefusal = async (
  props: SettleAttemptProps,
  log: Logger
): Promise<InvalidStateError | StorageError | undefined> => {
  if (props.blockedReason !== undefined || props.shouldFailAttempt === true) return undefined;
  if (props.hasUncommittedChanges === undefined) return undefined;
  const dirty = await props.hasUncommittedChanges();
  if (!dirty.ok) {
    log.error('settle: worktree status check failed', { taskId: props.task.id, error: dirty.error.message });
    return dirty.error;
  }
  if (!dirty.value) return undefined;
  const cwdHint = props.cwd !== undefined ? ` in '${String(props.cwd)}'` : '';
  const message = `cannot settle task '${props.task.id}' as done: worktree${cwdHint} has uncommitted changes; the commit-task leaf must have failed or the AI wrote files after committing`;
  log.error(message, { taskId: props.task.id, verdict: props.verdict });
  return new InvalidStateError({
    entity: 'working-tree',
    currentState: 'dirty',
    attemptedAction: 'settle-attempt',
    message,
    hint: 'Inspect the diff in the task worktree, fix the cause (e.g. commit-message hook, untracked files), then rerun the sprint. The task remains in_progress.',
  });
};

export const settleAttemptUseCase = async (
  props: SettleAttemptProps
): Promise<Result<SettleAttemptOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.settle-attempt');
  log.debug('settling running attempt', settleLogMeta(props));

  const refused = await dirtyTreeRefusal(props, log);
  if (refused !== undefined) return Result.error(refused);

  const now = props.clock();
  const settled = settleTask(props, now);
  if (!settled.ok) {
    log.warn('settle failed', { taskId: props.task.id, error: settled.error.message });
    return Result.error(settled.error);
  }

  const folded = props.criteria !== undefined ? applyCriteriaVerdicts(settled.value, props.criteria) : settled.value;

  const persisted = await props.taskRepo.update(props.sprintId, folded);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: folded.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`settled task → ${folded.status}`, {
    taskId: props.task.id,
    verdict: props.verdict,
    finalStatus: folded.status,
    ...(props.blockedReason !== undefined ? { blockedReason: props.blockedReason } : {}),
    ...(folded.status === 'blocked' ? { blockCause: folded.blockCause, faultSide: folded.faultSide } : {}),
  });
  // Notify only once the block is durable.
  if (props.eventBus !== undefined && folded.status === 'blocked') publishTaskBlocked(props.eventBus, folded, now);
  return Result.ok(folded);
};
