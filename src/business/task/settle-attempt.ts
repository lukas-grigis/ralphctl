import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { TaskBlockedEvent } from '@src/business/observability/events.ts';
import type { Logger, LogMeta } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbortCause, AbortMetadata, AttemptUsage, AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, DoneTask, FaultSide, InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptUsage, recordRunningAttemptWarning } from '@src/domain/entity/task-attempts.ts';
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
 * Settle a running attempt at the end of one gen-eval loop. The locked policy
 * (see {@link AttemptWarning} in `domain/entity/attempt.ts`) is:
 *
 *   `blockedReason` set                       → mark task blocked
 *                                               (running attempt settled as aborted first)
 *   any verdict, no blockedReason             → mark task done
 *
 * `verdict` is captured for logging and audit only — the inner-loop policy already mapped each
 * termination kind inside `finalize-gen-eval` (`self-blocked` → `markTaskBlocked`; a
 * failure-driven escalation / nudge / malformed-retry → `shouldFailAttempt` keeping the task
 * `in_progress` for the next attempt; an exhausted-remedy `plateau` / `budget-exhausted` /
 * `malformed` → `markTaskDone` + structured warning). The optional `warning` is stamped onto the
 * running attempt before the task transitions so attempt history carries the failure-mode for
 * review tooling.
 *
 * Why some failures retry and others settle "done with warning": when the escalation policy grants
 * one more attempt (model bump, top-of-ladder nudge, or plain same-model malformed retry, all
 * bounded by the effective `maxAttempts`) `shouldFailAttempt` keeps the task `in_progress` so the
 * outer attempt loop re-enters with the stronger model / fresh session. Once the remedy ladder is
 * exhausted or the attempt budget runs out the work is preserved (`markTaskDone` + warning) — the
 * operator inspects the warning and decides whether to redo the task.
 */
export type SettleVerdict = 'passed' | 'failed' | 'malformed';

export interface SettleAttemptProps {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly verdict: SettleVerdict;
  readonly blockedReason?: string;
  readonly warning?: AttemptWarning;
  /**
   * Fail the current running attempt instead of marking the task `done`. Set by the escalation
   * policy when a plateau triggered a once-per-task generator-model upgrade — the attempt's
   * critique stays useful but the task must stay `in_progress` so the next chain invocation
   * picks it up with the escalated model. When the running attempt count then reaches
   * `task.maxAttempts`, `failCurrentAttempt` itself transitions the task to `blocked`. Ignored
   * when `blockedReason` is set (the block path already settles the attempt as aborted).
   */
  readonly shouldFailAttempt?: boolean;
  /**
   * Structured per-criterion verdicts the evaluator graded THIS round, projected from
   * `ctx.lastEvaluation.criteria`. Folded onto the settled task's harness-owned
   * `criteriaVerdicts` (ids not graded this round keep their prior verdict). HARNESS-authored,
   * derived from the evaluator's structured signal — never from agent prose. Absent → no fold.
   */
  readonly criteria?: readonly CriterionVerdict[];
  /**
   * Why the running attempt died, for the block path (the ONE in-process settle that closes an
   * attempt as `aborted`). Absent → {@link SELF_BLOCKED_CAUSE}: the task blocked itself and no
   * process was killed. Set by the caller when a terminal AI-process crash is what drove the
   * block, so `runs stats`' abort-by-cause table separates a watchdog kill from a self-block
   * instead of bucketing every block as `unknown`. Ignored on every non-block path — those
   * settle the attempt `verified` / `failed` / `malformed`, where an abort cause is meaningless.
   */
  readonly abortCause?: AbortCause;
  /** POSIX signal name / numeric exit code for {@link abortCause}, when the crash reported one. */
  readonly signalOrExitCode?: string | number;
  /**
   * The generator's own structured triage for a `task-blocked` signal — see
   * {@link TaskBlockerClass} in `domain/signal.ts`, threaded here from
   * `GeneratorTurnExit.blockerClass` (`run-generator-turn.ts`). Persisted onto the resulting
   * `BlockedTask` (`domain/entity/task.ts`) alongside {@link question} / {@link whatUnblocksMe}.
   * Ignored on every non-block path (same posture as {@link abortCause}) and absent for a
   * self-block whose signal omitted it — all three are optional at the source.
   */
  readonly blockerClass?: TaskBlockerClass;
  /** The single concrete question the generator said would unblock it. Same posture as {@link blockerClass}. */
  readonly question?: string;
  /** What the generator said the operator needs to supply/decide. Same posture as {@link blockerClass}. */
  readonly whatUnblocksMe?: string;
  /**
   * Raw cost telemetry accumulated across this attempt's AI spawns — provider-reported token
   * counts plus harness-measured AI wall-clock. Stamped onto the running attempt before the
   * terminal transition so the figures ride into the persisted record; the settle point is the
   * only place they exist alongside the attempt they belong to (they otherwise die as ephemeral
   * `token-usage` events). Absent → nothing is stamped, and no zero is invented.
   */
  readonly usage?: AttemptUsage;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /**
   * Publishes {@link TaskBlockedEvent} the moment this use case persists a task as `blocked` —
   * see {@link publishTaskBlocked}. Optional so existing callers (and every test that doesn't
   * care about notifications) keep working unchanged; omitted → the settle still happens, it
   * just stays as silent as it was before this event existed.
   */
  readonly eventBus?: EventBus;
  /**
   * Worktree-clean guardrail. Settle refuses to mark a task `done` when this returns `true` —
   * a dirty tree at settle time means commit-task either silently skipped or the AI created
   * untracked files after the commit ran. Either way, "done" would lie about what landed in
   * git. Optional so tests can opt out; production wires it from the implement chain's git
   * runner against the task's cwd.
   */
  readonly hasUncommittedChanges?: () => Promise<Result<boolean, StorageError>>;
  /** Used only in error messages so the operator knows which worktree to inspect. */
  readonly cwd?: AbsolutePath;
}

export type SettleAttemptOutput = DoneTask | InProgressTask | BlockedTask;

/**
 * Default {@link AbortCause} for the block path: the task blocked (generator `<task-blocked>`,
 * a signals-contract failure, or a red harness verify gate) and NOTHING was killed. Naming it
 * keeps those attempts out of the `unknown` bucket, which previously absorbed every self-block
 * and so made the whole abort-cause taxonomy unreadable in `runs stats`.
 */
const SELF_BLOCKED_CAUSE = 'self-blocked';

/**
 * The abort attribution for the block path — the caller's crash forensics when it had any, else
 * {@link SELF_BLOCKED_CAUSE}. Extracted so the settle decision tree itself stays a flat list of
 * transitions.
 */
const abortMetaFor = (props: Pick<SettleAttemptProps, 'abortCause' | 'signalOrExitCode'>): AbortMetadata => ({
  abortCause: props.abortCause ?? SELF_BLOCKED_CAUSE,
  ...(props.signalOrExitCode !== undefined ? { signalOrExitCode: props.signalOrExitCode } : {}),
});

/** The first newline-delimited line of `text` — a banner/notification-sized summary, never the
 * full multi-line `blockedReason` (which can carry a quarantine-stash pointer on later lines). */
const firstLine = (text: string): string => text.split('\n', 1)[0] ?? text;

/**
 * Publish {@link TaskBlockedEvent} for a task that just settled into `blocked`, so
 * `notification-subscriber`'s `classify()` can raise the operator-attention banner / OS
 * notification. A no-op when no `eventBus` was wired (legacy / test callers) or when the settled
 * task isn't actually blocked — kept as a single guarded call so the use case's happy path below
 * reads as one line, not a branch.
 */
const publishTaskBlocked = (eventBus: EventBus | undefined, task: SettleAttemptOutput, at: IsoTimestamp): void => {
  if (eventBus === undefined || task.status !== 'blocked') return;
  const event: TaskBlockedEvent = {
    type: 'task-blocked',
    taskId: String(task.id),
    taskName: task.name,
    blockKind: task.blockKind,
    reason: firstLine(task.blockedReason),
    at,
  };
  eventBus.publish(event);
};

/** Structured detail for the entry-point log line; kept out of the use case's own branch budget. */
const settleLogMeta = (props: SettleAttemptProps): LogMeta => ({
  taskId: props.task.id,
  verdict: props.verdict,
  ...(props.blockedReason !== undefined ? { blockedReason: props.blockedReason } : {}),
  ...(props.warning !== undefined ? { warning: props.warning.kind } : {}),
  ...(props.abortCause !== undefined ? { abortCause: props.abortCause } : {}),
});

/**
 * Backfill `{ blockCause, faultSide }` onto a just-settled `BlockedTask` when the domain
 * transition that produced it didn't classify it — `failCurrentAttempt`'s own attempt-budget-cap
 * literal (`task-settle.ts`) constructs a `BlockedTask` with no knowledge of either field. A no-op
 * for a non-blocked result, or one that already carries a classification (the `markTaskBlocked` /
 * direct-literal paths a few lines down classify explicitly, so this never double-processes them).
 *
 * `hints.abortCause` carries this attempt's crash forensics when there are any (see
 * {@link abortMetaFor}) so a budget exhaustion driven by repeated watchdog kills / process crashes
 * classifies as a harness/environment fault rather than the text-based default of `model`.
 * `hints.faultSide: 'grader'` is set by the caller when `verdict === 'malformed'` — the evaluator's
 * own repeated contract failures, not the generator's, drove the exhaustion.
 */
const classifyIfBlocked = (
  result: Result<DoneTask | InProgressTask | BlockedTask, InvalidStateError>,
  hints: { readonly abortCause?: AbortCause | undefined; readonly faultSide?: FaultSide | undefined }
): Result<DoneTask | InProgressTask | BlockedTask, InvalidStateError> => {
  if (!result.ok) return result;
  const task = result.value;
  if (task.status !== 'blocked' || task.blockCause !== undefined) return result;
  const classified = classifyBlock(task.blockedReason, task.blockKind, hints);
  return Result.ok({ ...task, ...classified });
};

/**
 * The generator's structured triage fields (see {@link SettleAttemptProps.blockerClass}), ready to
 * spread onto a `BlockedTask` literal — each present only when the caller supplied it. Split out
 * so both branches of {@link settleAsBlocked} stamp them identically rather than drifting.
 */
const triageCarry = (
  hints: Pick<SettleAttemptProps, 'blockerClass' | 'question' | 'whatUnblocksMe'>
): Pick<BlockedTask, 'blockerClass' | 'question' | 'whatUnblocksMe'> => ({
  ...(hints.blockerClass !== undefined ? { blockerClass: hints.blockerClass } : {}),
  ...(hints.question !== undefined ? { question: hints.question } : {}),
  ...(hints.whatUnblocksMe !== undefined ? { whatUnblocksMe: hints.whatUnblocksMe } : {}),
});

/**
 * Settle the running attempt into the terminal `blocked` state for the block path — the one
 * in-process settle that closes an attempt as `aborted`, then classifies WHY from the real block
 * reason text. Extracted out of {@link settleTask}: this path's own abort/classify/status-shape
 * branching was tipping that function's cognitive complexity past its budget, and the block path
 * is self-contained — given an in-progress task and its blocked reason, it always ends in a
 * `blocked` task or an early abort error, never in `done` or a retry.
 */
const settleAsBlocked = (
  task: InProgressTask,
  blockedReason: string,
  now: IsoTimestamp,
  hints: Pick<SettleAttemptProps, 'abortCause' | 'signalOrExitCode' | 'blockerClass' | 'question' | 'whatUnblocksMe'>
): Result<DoneTask | InProgressTask | BlockedTask, InvalidStateError> => {
  // The one in-process settle that closes an attempt as `aborted` — so it is also the one place
  // that can attribute WHY. A crash-driven block carries the provider's cause + exit shape; a
  // plain task block is `self-blocked` (nothing was killed), never `unknown`.
  const aborted = failCurrentAttempt(task, now, 'aborted', abortMetaFor(hints));
  if (!aborted.ok) return Result.error(aborted.error);
  // Classify once, from THIS block's real reason text — never fall back to the generic
  // 'unknown' persistence-layer default, since we know structurally this path is generator
  // self-block / pre-verify-red / post-verify-regression / crash-driven-exhaustion, never
  // fold-conflict, worktree-setup, upstream, or operator-cancel (those settle elsewhere).
  const classification = classifyBlock(blockedReason, 'own', {
    abortCause: hints.abortCause,
    ownDefault: 'generator-self-block',
  });
  // A self-block (the generator emitted `<task-blocked>`) is an own-failure block — the operator
  // must address the blocker; it never cascade-clears via the upstream-unblock path.
  if (aborted.value.status === 'blocked') {
    return Result.ok({ ...aborted.value, blockedReason, blockKind: 'own', ...classification, ...triageCarry(hints) });
  }
  const marked = markTaskBlocked(aborted.value, blockedReason, 'own', classification);
  if (!marked.ok) return marked;
  return Result.ok({ ...marked.value, ...triageCarry(hints) });
};

const settleTask = (
  props: Pick<
    SettleAttemptProps,
    | 'task'
    | 'warning'
    | 'blockedReason'
    | 'shouldFailAttempt'
    | 'verdict'
    | 'usage'
    | 'abortCause'
    | 'signalOrExitCode'
    | 'blockerClass'
    | 'question'
    | 'whatUnblocksMe'
  >,
  now: IsoTimestamp
): Result<DoneTask | InProgressTask | BlockedTask, InvalidStateError> => {
  let task: InProgressTask = props.task;
  // Stamp cost telemetry FIRST: every branch below settles the running attempt into a terminal
  // one, so anything not recorded by this point is lost with it.
  if (props.usage !== undefined) {
    const stamped = recordRunningAttemptUsage(task, props.usage);
    if (!stamped.ok) return Result.error(stamped.error);
    task = stamped.value;
  }
  if (props.warning !== undefined) {
    const stamped = recordRunningAttemptWarning(task, props.warning);
    if (!stamped.ok) return Result.error(stamped.error);
    task = stamped.value;
  }
  // PRECEDENCE: a granted retry outranks a block reason. finalize-gen-eval never sets both —
  // when they co-occur it is because a LATER leaf (a red post-task-verify) stamped the block
  // AFTER finalize granted the retry (escalate / nudge / malformed same-model retry). The whole
  // point of the remedy ladder is to spend remedies before surrendering, and a red verify on the
  // failing work is exactly the signal a stronger-model retry targets — so the retry runs. The
  // red work never lands: the commit guard keys on the block reason independently, and the
  // retry-diff quarantine stashes the rejected diff so the next attempt starts clean. Once the
  // budget exhausts, finalize stops granting retries and the same red verify blocks the task.
  if (props.shouldFailAttempt === true) {
    // Settle the running attempt — `malformed` when the evaluator's contract failure drove the
    // retry (the attempt history must report the real failure mode), `failed` otherwise. Keeps
    // the task `in_progress` (or `blocked` if the running attempt count just hit the cap); the
    // next chain invocation re-attempts with the escalated (or same, for malformed) model.
    const malformed = props.verdict === 'malformed';
    const result = failCurrentAttempt(task, now, malformed ? 'malformed' : 'failed');
    // A block reached THIS way is always attempt-budget exhaustion (no other transition in
    // `failCurrentAttempt` produces one) — classify the fault side from what actually exhausted
    // it: a repeatedly malformed EVALUATOR is a `grader` fault, a crash-driven exhaustion is
    // `abortCause`'s harness/environment attribution, otherwise the text-based default applies.
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

export const settleAttemptUseCase = async (
  props: SettleAttemptProps
): Promise<Result<SettleAttemptOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.settle-attempt');
  log.debug('settling running attempt', settleLogMeta(props));

  // Guardrail: if we're about to mark the task `done` but the worktree is dirty, refuse.
  // A dirty tree at this point means commit-task didn't capture every change — usually
  // because the AI wrote files (or touched .gitignored paths that became tracked) after
  // commit ran. Marking "done" would lie about what's in git. The block + shouldFailAttempt
  // paths are exempt: self-blocked and escalation-retry tasks are allowed to leave changes
  // in place for the operator to inspect or the next attempt to consume.
  if (
    props.blockedReason === undefined &&
    props.shouldFailAttempt !== true &&
    props.hasUncommittedChanges !== undefined
  ) {
    const dirty = await props.hasUncommittedChanges();
    if (!dirty.ok) {
      log.error('settle: worktree status check failed', {
        taskId: props.task.id,
        error: dirty.error.message,
      });
      return Result.error(dirty.error);
    }
    if (dirty.value) {
      const cwdHint = props.cwd !== undefined ? ` in '${String(props.cwd)}'` : '';
      const message = `cannot settle task '${props.task.id}' as done: worktree${cwdHint} has uncommitted changes; the commit-task leaf must have failed or the AI wrote files after committing`;
      log.error(message, { taskId: props.task.id, verdict: props.verdict });
      return Result.error(
        new InvalidStateError({
          entity: 'working-tree',
          currentState: 'dirty',
          attemptedAction: 'settle-attempt',
          message,
          hint: 'Inspect the diff in the task worktree, fix the cause (e.g. commit-message hook, untracked files), then rerun the sprint. The task remains in_progress.',
        })
      );
    }
  }

  const now = props.clock();
  const settled = settleTask(props, now);
  if (!settled.ok) {
    log.warn('settle failed', { taskId: props.task.id, error: settled.error.message });
    return Result.error(settled.error);
  }

  // Fold this round's structured per-criterion verdicts onto the settled task's durable
  // `criteriaVerdicts` BEFORE persisting. Harness-authored from the evaluator's structured signal —
  // settleTask already carried any prior verdicts through, so the fold only overlays this round.
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
  // Only once the block is durable (persisted above) does the operator-facing notification fire —
  // see `publishTaskBlocked`. No-ops for every non-blocked outcome and for callers with no bus.
  publishTaskBlocked(props.eventBus, folded, now);
  return Result.ok(folded);
};
