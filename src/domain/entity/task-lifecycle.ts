import { Result } from '@src/domain/result.ts';
import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { BlockCause, BlockedTask, FaultSide, RetiredRun, Task, TodoTask } from '@src/domain/entity/task.ts';
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

/**
 * The {@link BlockCause} member meaning "the task ran out of its attempt budget" — shared by
 * {@link inferBlockCause} (inferring it from crash / explicit-exhaustion reason text) and
 * {@link defaultFaultSideFor} (matching on it to pick a crash-vs-model-driven fault side). `satisfies`
 * rather than a `: BlockCause` annotation so the constant keeps its literal type — required for
 * `defaultFaultSideFor`'s `switch` to stay exhaustively checked against every `BlockCause` member.
 */
const BUDGET_EXHAUSTED_BLOCK_CAUSE = 'budget-exhausted' satisfies BlockCause;

/**
 * Read-time / construction-time inference for {@link BlockCause} — mirrors the reason-prefix
 * inference {@link BLOCKED_UPSTREAM_REASON_PREFIX} already does for `blockKind`, one level more
 * granular. `blockKind === 'upstream'` always resolves to `'upstream-dependency'` (no need to
 * inspect the reason text — the structural discriminant already settles it). For an `'own'` block
 * the reason text is pattern-matched against every literal prefix the harness's own producers are
 * known to write (`wave-branch.ts`'s fold-conflict / worktree-setup-failure text,
 * `pre-task-verify-internals`'s broken-baseline text, `post-task-verify.ts`'s verify-script text,
 * `finalize-gen-eval.ts`'s crash + budget-exhaustion text, `cancel-active-task.ts`'s operator-cancel
 * text) — falling back to `ownDefault` when nothing matches. Callers with extra context (e.g.
 * `settleAttemptUseCase`, which knows its `blockedReason` path is generator-self-block /
 * verify-driven and never fold-conflict / upstream / operator-cancel) pass a narrower
 * `ownDefault` than the persistence codec's true "no idea" `'unknown'`.
 *
 * EVERY check below is anchored to the literal producer text (`startsWith`, never a bare
 * `.includes` on a common English word) and ordered so no anchored prefix sits behind a looser
 * one — a generator self-block's free-form prose can legitimately mention "crashed" or "cancel"
 * (describing what the TASK is about, not what happened to the harness) without being
 * misclassified as a harness-driven `budget-exhausted` / `operator-cancelled` block.
 */
export const inferBlockCause = (
  blockKind: BlockedTask['blockKind'],
  reason: string,
  ownDefault: BlockCause = 'unknown'
): BlockCause => {
  if (blockKind === 'upstream') return 'upstream-dependency';
  if (reason.startsWith('attempt budget exhausted')) return BUDGET_EXHAUSTED_BLOCK_CAUSE;
  // Anchored to `finalize-gen-eval.ts`'s exact literal (`'AI process repeatedly crashed; attempt
  // budget exhausted'`) rather than a bare `.includes('crashed')` — the latter matched ANY reason
  // text mentioning a crash, including a generator self-block whose prose happens to describe a
  // crashing dependency (e.g. "the payment sandbox crashed on every run").
  if (reason.startsWith('AI process repeatedly crashed')) return BUDGET_EXHAUSTED_BLOCK_CAUSE;
  if (reason.startsWith('fold conflict')) return 'fold-conflict';
  if (reason.startsWith('worktree setup script failed')) return 'worktree-setup-failure';
  if (reason.includes('broken baseline') || reason.includes('baseline already red')) return 'pre-verify-red';
  if (reason.startsWith('verify script')) return 'post-verify-regression';
  // Anchored to `cancel-active-task.ts` / the TUI cancel handler's exact literal (`'user cancel'`)
  // rather than a bare `.includes('cancel')` — the latter matched a self-block reason that merely
  // mentions a cancellation POLICY being ambiguous, not an actual operator cancel.
  if (reason.startsWith('user cancel')) return 'operator-cancelled';
  return ownDefault;
};

/**
 * Default {@link FaultSide} per {@link BlockCause}, used when neither the caller nor
 * {@link faultSideForAbortCause} supplies one. `budget-exhausted` is the one cause whose fault side
 * genuinely depends on WHY the budget ran out — text-matched the same way {@link inferBlockCause}
 * detects a crash-driven exhaustion, since a caller with definitive crash forensics should prefer
 * {@link faultSideForAbortCause} instead of falling through to this text match.
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

/**
 * True when a retired run is worth archiving — at least one attempt, a verdict map, or an
 * escalation stamp survived to the block. An upstream-cascade dependent unblocked with nothing of
 * its own carries none of these, and archiving an empty entry would just be noise in `tasks.json`.
 */
const hasArchivableState = (run: RetiredRun): boolean =>
  run.attempts.length > 0 ||
  run.criteriaVerdicts !== undefined ||
  run.escalatedFromModel !== undefined ||
  run.escalatedToModel !== undefined ||
  run.escalatedToEffort !== undefined ||
  run.escalatedToEvaluatorEffort !== undefined;

/**
 * Unblock a `blocked` task back to `todo` as a CLEAN RESTART: strip the block fields AND reset the
 * attempt budget (empty `attempts`) and any carried-over model escalation. A deliberate operator
 * unblock means "the blocker is addressed — give this task a genuine fresh run," so it re-enters
 * with a full `maxAttempts` budget on the configured model, behaving like a freshly-planned task.
 *
 * Without the reset, an own-blocked task sitting at a full attempt history would, on its next run,
 * hit `budget-exhausted` on the first plateau (no room to climb the escalation ladder again) — and
 * carrying a top-of-ladder escalation stamp would `topped-out` immediately.
 *
 * This is an ARCHIVE, not a deletion: the attempts, per-criterion verdicts and escalation stamps
 * cleared from the live fields are packaged into one {@link RetiredRun} and appended to
 * {@link Task.retiredAttempts} (oldest first) rather than discarded. The per-attempt history also
 * still lives in `progress.md` and git; this is what keeps it in `tasks.json` too, so
 * `foldOutcomeStats` and any future forensic view can still see it after the live ledger resets. A
 * run with nothing worth keeping (see {@link hasArchivableState}) is not archived — an upstream-
 * cascade dependent re-armed with zero attempts of its own does not grow the archive.
 *
 * The one stamp a clean restart KEEPS live is the permanent `bestOfNGranted` marker (the
 * once-per-task gate); its transient `bestOfNGrantedCandidates` handshake is dropped entirely —
 * neither archived nor carried forward — see the destructure below.
 *
 * Distinct from {@link resetTaskToTodo} (crash recovery), which PRESERVES attempts because it
 * resumes mid-work rather than restarting.
 */
export const unblockTask = (task: Task): Result<TodoTask, InvalidStateError> => {
  const guard = requireStatus('task', task, ['blocked'] as const, 'unblock');
  if (!guard.ok) return Result.error(guard.error);
  const {
    blockedReason: _reason,
    blockKind: _kind,
    // Same clean-restart rationale as `_reason` / `_kind` immediately above — a fresh `todo` task
    // carries no block classification at all, so these are dropped rather than carried forward.
    blockCause: _blockCause,
    faultSide: _faultSide,
    // The GENERATOR's own structured triage for the block just cleared — same clean-restart
    // rationale as `blockCause` / `faultSide` immediately above: a fresh `todo` task has no block
    // to triage yet, so a stale answer from the PRIOR block cycle must not ride onto it. Dropped,
    // not archived (same posture as `blockCause` / `faultSide`, unlike `criteriaVerdicts` below).
    blockerClass: _blockerClass,
    question: _question,
    whatUnblocksMe: _whatUnblocksMe,
    escalatedFromModel,
    escalatedToModel,
    // The raised effort is a per-run remedy like the model bump — a clean restart drops it so the
    // fresh run begins on the configured effort again (archived, not carried forward).
    escalatedToEffort,
    // Evaluator-side counterpart of the effort remedy above — same clean-restart rationale.
    escalatedToEvaluatorEffort,
    // A clean restart drops the prior run's per-criterion verdicts too — a freshly-planned task
    // carries no k-of-N history; stale verdicts would mislead the next run's checklist. Archived,
    // not carried forward.
    criteriaVerdicts,
    // The best-of-N handshake is transient: it is meant to be consumed by the ATTEMPT it was issued
    // for. A grant stamped but never consumed (the attempt was cancelled / self-blocked before
    // `best-of-n-selection` cleared it) would otherwise ride onto a task with zero attempts and make
    // the restarted run's FIRST attempt sample N candidate generator sessions — an unexpected N×
    // spend on what the operator asked to be a fresh run. The PERMANENT `bestOfNGranted` marker is
    // deliberately NOT stripped: it is the once-per-task gate `decideEscalation` reads, and clearing
    // it would let repeated block/unblock cycles re-grant N sessions without bound.
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

  return Result.ok({
    ...rest,
    status: 'todo',
    attempts: [],
    ...(archive.length > 0 ? { retiredAttempts: archive } : {}),
  });
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
  const last = guard.value.attempts[guard.value.attempts.length - 1];
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
