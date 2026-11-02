import { Result } from '@src/domain/result.ts';
import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { BlockCause, BlockedTask, FaultSide, RetiredRun, Task, TodoTask } from '@src/domain/entity/task.ts';
import { type DatedPriorWorkDecision, decidePriorWork } from '@src/domain/entity/task-prior-work.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Reason-string prefix the dependency gate stamps on a task blocked solely because a prerequisite
 * was not `done`.
 *
 * @deprecated Superseded by the structural {@link BlockedTask.blockKind} discriminant. Retained
 * ONLY for the read-time migration of legacy `tasks.json` entries lacking `blockKind` (the task
 * schema infers `upstream` from this prefix, `own` otherwise). New code MUST classify via
 * {@link isUpstreamBlocked} / `blockKind`, never the reason text.
 */
export const BLOCKED_UPSTREAM_REASON_PREFIX = 'blocked upstream';

/**
 * True when `task` is blocked specifically because an upstream prerequisite was not done. Reads the
 * structural {@link BlockedTask.blockKind} discriminant — NOT the reason prefix — so an own-failure
 * reason that happens to start with `'blocked upstream'` is correctly NOT treated as upstream.
 */
export const isUpstreamBlocked = (task: Task): task is BlockedTask =>
  task.status === 'blocked' && task.blockKind === 'upstream';

/** `satisfies`, not `: BlockCause`, so the literal type keeps `defaultFaultSideFor`'s switch exhaustive. */
const BUDGET_EXHAUSTED_BLOCK_CAUSE = 'budget-exhausted' satisfies BlockCause;

/**
 * Infer a {@link BlockCause}: `upstream` blocks are always `upstream-dependency`; `own` blocks are
 * matched against the literal prefixes the harness's own producers write, else `ownDefault`.
 * Every check is anchored with `startsWith` on the producer's exact text, never `.includes` on a
 * common word — a self-block's prose may legitimately mention "crashed", "cancel" or "broken
 * baseline" while describing the task itself.
 */
export const inferBlockCause = (
  blockKind: BlockedTask['blockKind'],
  reason: string,
  ownDefault: BlockCause = 'unknown'
): BlockCause => {
  if (blockKind === 'upstream') return 'upstream-dependency';
  if (reason.startsWith('attempt budget exhausted')) return BUDGET_EXHAUSTED_BLOCK_CAUSE;
  if (reason.startsWith('AI process repeatedly crashed')) return BUDGET_EXHAUSTED_BLOCK_CAUSE;
  if (reason.startsWith('fold conflict')) return 'fold-conflict';
  if (reason.startsWith('worktree setup script failed')) return 'worktree-setup-failure';
  if (reason.startsWith('baseline already red') || reason.startsWith('operator skipped task on broken baseline')) {
    return 'pre-verify-red';
  }
  if (reason.startsWith('verify script')) return 'post-verify-regression';
  if (reason.startsWith('user cancel')) return 'operator-cancelled';
  return ownDefault;
};

/**
 * Default {@link FaultSide} per {@link BlockCause}. `budget-exhausted` depends on why the budget ran
 * out; callers with crash forensics should prefer {@link faultSideForAbortCause} over this text match.
 */
export const defaultFaultSideFor = (cause: BlockCause, reason: string): FaultSide => {
  switch (cause) {
    case 'upstream-dependency':
      return 'harness';
    case 'fold-conflict':
      return 'harness';
    case 'operator-cancelled':
      return 'harness';
    case 'worktree-setup-failure':
      return 'environment';
    case 'pre-verify-red':
      return 'environment';
    case 'post-verify-regression':
      return 'model';
    case 'generator-self-block':
      return 'model';
    case BUDGET_EXHAUSTED_BLOCK_CAUSE:
      return reason.includes('crashed') ? 'harness' : 'model';
    case 'unknown':
      return 'unknown';
  }
};

/**
 * {@link AbortCause} → {@link FaultSide} for the handful of values that carry definitive crash
 * forensics — a killed / crashed AI process is never the model's own fault, regardless of what the
 * block's reason text says. `undefined` for `'self-blocked'` / `'unknown'` (neither adds
 * fault-side information beyond the reason text) and any value not listed — the caller then falls
 * through to {@link defaultFaultSideFor}'s text-based guess.
 */
const FAULT_SIDE_BY_ABORT_CAUSE: Readonly<Partial<Record<AbortCause, FaultSide>>> = {
  'watchdog-killed': 'harness',
  sigterm: 'harness',
  'user-cancel': 'harness',
  'rate-limit-exhausted': 'environment',
  'process-crash': 'environment',
  'harness-interrupted': 'harness',
};

export const faultSideForAbortCause = (cause: AbortCause): FaultSide | undefined => FAULT_SIDE_BY_ABORT_CAUSE[cause];

/**
 * Resolve the `{ blockCause, faultSide }` pair a `BlockedTask` should carry — the single entry
 * point every block-producing call site funnels through (directly, via `markTaskBlocked`, or via
 * `settleAttemptUseCase`'s own direct constructions) so the priority order never drifts between
 * them:
 *
 *   1. an explicit `hints.blockCause` / `hints.faultSide` — the caller already knows (e.g.
 *      `wave-branch.ts` knows a fold conflict is `fold-conflict` + `harness` without any inference).
 *   2. `hints.abortCause` — definitive crash forensics override a text-based fault-side guess.
 *   3. text / `blockKind`-based inference (`inferBlockCause` / `defaultFaultSideFor`).
 */
export const classifyBlock = (
  reason: string,
  blockKind: BlockedTask['blockKind'],
  hints?: {
    readonly blockCause?: BlockCause | undefined;
    readonly faultSide?: FaultSide | undefined;
    readonly abortCause?: AbortCause | undefined;
    readonly ownDefault?: BlockCause | undefined;
  }
): { readonly blockCause: BlockCause; readonly faultSide: FaultSide } => {
  const blockCause = hints?.blockCause ?? inferBlockCause(blockKind, reason, hints?.ownDefault);
  const faultSide =
    hints?.faultSide ??
    (hints?.abortCause !== undefined ? faultSideForAbortCause(hints.abortCause) : undefined) ??
    defaultFaultSideFor(blockCause, reason);
  return { blockCause, faultSide };
};

export const markTaskBlocked = (
  task: Task,
  reason: string,
  blockKind: BlockedTask['blockKind'],
  classification?: { readonly blockCause?: BlockCause | undefined; readonly faultSide?: FaultSide | undefined }
): Result<BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'mark-blocked',
    'Done or already-blocked tasks cannot be re-blocked.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const { blockCause, faultSide } = classifyBlock(reason, blockKind, classification);
  return Result.ok({ ...guard.value, status: 'blocked', blockedReason: reason, blockKind, blockCause, faultSide });
};

/** An upstream-cascade dependent unblocked with nothing of its own would only add noise to the archive. */
const hasArchivableState = (run: RetiredRun): boolean =>
  run.attempts.length > 0 ||
  run.criteriaVerdicts !== undefined ||
  run.escalatedFromModel !== undefined ||
  run.escalatedToModel !== undefined ||
  run.escalatedToEffort !== undefined ||
  run.escalatedToEvaluatorEffort !== undefined;

/**
 * Unblock a `blocked` task back to `todo` as a CLEAN RESTART: block fields stripped, attempt budget
 * and escalation stamps reset — otherwise the next run would hit `budget-exhausted` or `topped-out`
 * at once. The cleared state is archived as a {@link RetiredRun}, not deleted (a run with nothing
 * worth keeping is skipped). The quarantined-diff fact survives, with the operator's decision.
 * Unlike {@link resetTaskToTodo} (crash recovery), which keeps attempts to resume mid-work.
 */
export const unblockTask = (task: Task, prior?: DatedPriorWorkDecision): Result<TodoTask, InvalidStateError> => {
  const guard = requireStatus('task', task, ['blocked'] as const, 'unblock');
  if (!guard.ok) return Result.error(guard.error);
  const {
    blockedReason: _reason,
    blockKind: _kind,
    // A fresh `todo` task has no block to classify or triage: these are dropped, not archived.
    blockCause: _blockCause,
    faultSide: _faultSide,
    blockerClass: _blockerClass,
    question: _question,
    whatUnblocksMe: _whatUnblocksMe,
    // Per-run remedies and verdicts: archived below, not carried forward.
    escalatedFromModel,
    escalatedToModel,
    escalatedToEffort,
    escalatedToEvaluatorEffort,
    criteriaVerdicts,
    // An unconsumed best-of-N handshake would make the fresh run's first attempt spend N sessions.
    // The permanent `bestOfNGranted` gate stays, or block/unblock cycles could re-grant without bound.
    bestOfNGrantedCandidates: _bestOfNCandidates,
    attempts,
    retiredAttempts,
    ...rest
  } = guard.value;
  void _reason;
  void _kind;
  void _blockCause;
  void _faultSide;
  void _blockerClass;
  void _question;
  void _whatUnblocksMe;
  void _bestOfNCandidates;

  const retiredRun: RetiredRun = {
    attempts,
    ...(criteriaVerdicts !== undefined ? { criteriaVerdicts } : {}),
    ...(escalatedFromModel !== undefined ? { escalatedFromModel } : {}),
    ...(escalatedToModel !== undefined ? { escalatedToModel } : {}),
    ...(escalatedToEffort !== undefined ? { escalatedToEffort } : {}),
    ...(escalatedToEvaluatorEffort !== undefined ? { escalatedToEvaluatorEffort } : {}),
  };
  const archive: readonly RetiredRun[] = hasArchivableState(retiredRun)
    ? [...(retiredAttempts ?? []), retiredRun]
    : (retiredAttempts ?? []);

  const todo: TodoTask = {
    ...rest,
    status: 'todo',
    attempts: [],
    ...(archive.length > 0 ? { retiredAttempts: archive } : {}),
  };
  return Result.ok(prior === undefined ? todo : decidePriorWork(todo, prior.decision, prior.decidedAt));
};

/**
 * Reset stale `in_progress` back to `todo` (for crash recovery). Requires there to be no
 * unsettled running attempt — call `failCurrentAttempt(..., 'aborted')` first to settle it.
 */
export const resetTaskToTodo = (task: Task): Result<TodoTask, InvalidStateError> => {
  if (task.status === 'todo') return Result.ok(task);
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'reset-to-todo',
    'Only `in_progress` tasks can be reset to todo.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const last = guard.value.attempts.at(-1);
  if (last !== undefined && last.status === 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'reset-to-todo',
        message: `task '${guard.value.id}' has a running attempt n=${last.n}`,
        hint: 'Settle the attempt via failCurrentAttempt(..., "aborted") before resetting.',
      })
    );
  }
  return Result.ok({ ...guard.value, status: 'todo' });
};
