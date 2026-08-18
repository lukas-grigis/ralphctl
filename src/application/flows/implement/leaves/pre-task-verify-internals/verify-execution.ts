import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun } from '@src/domain/entity/attempt.ts';
import { normalizeVerifyGates, runVerifyGatesUseCase } from '@src/business/task/run-verify-script.ts';
import type { RunVerifyScriptOutput } from '@src/business/task/run-verify-script.ts';
import { appendAttemptVerifyRun, markAttemptBaselineBroken } from '@src/domain/entity/task-attempts.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { setExecutionBaselineBrokenPolicy, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { ShellRunOptions, ShellScriptResult, ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { gitHasUncommittedChanges, gitStashPop } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type {
  LeafInput,
  LeafOutput,
  PreTaskVerifyEnvironment,
  PreTaskVerifyLeafDeps,
  PreTaskVerifyLeafOpts,
} from '@src/application/flows/implement/leaves/pre-task-verify.ts';

type RedBaselineDecision = 'proceed' | 'skip' | 'abort';

/**
 * Ask the operator how to handle a red baseline. Returns a `Result` so a prompt cancellation
 * (Ctrl-C inside the choice menu) is surfaced as an `AbortError` propagated transparently by
 * the chain runtime — same as any other user-initiated cancellation.
 */
const askRedBaselineDecision = async (
  interactive: InteractivePrompt,
  cwd: AbsolutePath,
  exitCode: number | null
): Promise<Result<RedBaselineDecision, DomainError>> => {
  const detail = exitCode !== null ? ` (exit=${String(exitCode)})` : '';
  return interactive.askChoice<RedBaselineDecision>(
    `Pre-task verify failed${detail} at ${String(cwd)}. The baseline is already red — how should the harness proceed?`,
    [
      {
        label: 'Proceed anyway — run the task on the broken baseline',
        value: 'proceed',
        description: 'remembered for the rest of this sprint until the baseline turns green again',
      },
      {
        label: 'Skip this task — mark it blocked, continue with the next task',
        value: 'skip',
        description: 'one-shot; the next task still gets prompted on a red baseline',
      },
      {
        label: 'Abort the sprint — stop the implement run now',
        value: 'abort',
        description: 'fix the baseline, then re-launch implement',
      },
    ]
  );
};

const isInteractive = (env: PreTaskVerifyEnvironment): boolean => env.isStdinTty && !env.isCi && !env.isNoTui;

/**
 * True iff the previous task's post-task-verify ran green over EVERY configured gate on this same
 * cwd (carried from `input.priorPostVerifyOutcome`). Drives {@link tryCarryBaselineShortCircuit}
 * AND gates {@link tryFreshSetupShortCircuit} — the two short-circuits never overlap; once a task
 * has post-verified green, the carry path owns the subsequent skip.
 *
 * The `coveredAllGates` requirement is what keeps the carry sound under structured `verifyGates`:
 * post-verify runs `fail-fast` SCOPED to the attempt's diff footprint, so its aggregate
 * `'success'` only means "every EXECUTED gate passed". Standing in for the full baseline on that
 * evidence would synthesize a green pre nothing measured, and a gate that was already red outside
 * the previous task's footprint would then attribute as `'regressed'` on this task — blaming the
 * AI for a baseline it never touched, burning the bounded red-verify retry, and bypassing both the
 * `baseline-broken` escape hatch and the operator's persisted `baselineBrokenPolicy: 'proceed'`
 * amnesty (both keyed on a RECORDED red pre). An absent flag (ctx written before the field existed)
 * counts as NOT covered — demote to running the real gate rather than assume coverage.
 */
export const isCarriedGreenForThisCwd = (input: LeafInput, cwd: AbsolutePath): boolean =>
  input.priorPostVerifyOutcome?.outcome === 'success' &&
  input.priorPostVerifyOutcome.coveredAllGates === true &&
  String(input.priorPostVerifyOutcome.cwd) === String(cwd);

/**
 * Carry-baseline short-circuit. When the previous task on this same cwd post-verified green and
 * the working tree is still clean, the script's outcome can only be the same — re-running it is
 * wasted compute (~2m30s on a typical repo). Skips the script, the audit-row append (no extra
 * `phase: 'pre'` row), the log file write, and the prompt. The synthetic `VerifyRun` returned is
 * for the leaf's contract only — `lastPreVerifyOutcome` correctly carries `'success'` through the
 * output projection so post-task-verify's attribution computation sees `pre=success`.
 *
 * Git status returning an error (corrupt repo, fs error) demotes to "ineligible" — the real
 * script runs instead, matching today's behavior verbatim. Returns `undefined` when the
 * short-circuit does not fire, so the caller falls through to the real verify path.
 */
export const tryCarryBaselineShortCircuit = async (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  input: LeafInput,
  carriedGreenForThisCwd: boolean
): Promise<LeafOutput | undefined> => {
  if (!carriedGreenForThisCwd) return undefined;
  const dirty = await gitHasUncommittedChanges(deps.gitRunner, opts.cwd);
  if (!dirty.ok || dirty.value) return undefined;
  deps.eventBus.publish({
    type: 'log',
    level: 'info',
    message: `pre-task-verify ${String(opts.cwd)}: short-circuited (carried green baseline, tree clean)`,
    at: deps.clock(),
  });
  return { task: input.task, run: syntheticGreenPreRun(deps.clock), execution: input.execution };
};

/**
 * Fresh-setup short-circuit (T13) — a strict generalisation of {@link tryCarryBaselineShortCircuit}
 * for the FIRST pre-verify of the run on this repo. The carry path only seeds from a PRIOR TASK's
 * green post-verify, so the first task of every launch always re-ran the gate even when this
 * launch's setup script just built+tested the same tree seconds earlier. When the operator has
 * opted in (`skipPreVerifyOnFreshSetup`), this launch's setup verified this repo green (the
 * run-scoped marker — NOT a persisted prior-launch success), and the tree is clean, synthesize
 * the SAME green baseline so downstream attribution + the PRE_VERIFY_RESULTS rendering fold to
 * the identical path. Gated on the carry being absent so the two short-circuits never overlap.
 */
export const tryFreshSetupShortCircuit = async (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  input: LeafInput,
  carriedGreenForThisCwd: boolean
): Promise<LeafOutput | undefined> => {
  const eligible =
    opts.skipPreVerifyOnFreshSetup === true &&
    !carriedGreenForThisCwd &&
    (input.setupVerifiedRepoIds ?? []).some((id) => String(id) === String(input.repositoryId));
  if (!eligible) return undefined;
  const dirty = await gitHasUncommittedChanges(deps.gitRunner, opts.cwd);
  if (!dirty.ok || dirty.value) return undefined;
  deps.eventBus.publish({
    type: 'log',
    level: 'info',
    message: `pre-task-verify ${String(opts.cwd)}: short-circuited (this run's setup verified the tree green, tree clean)`,
    at: deps.clock(),
  });
  return { task: input.task, run: syntheticGreenPreRun(deps.clock), execution: input.execution };
};

/**
 * Normalise legacy script + structured gates into ONE gate list (gates win when present), then
 * run the FULL set with NO scope — `all-run` mode. Pre-verify is the attribution baseline; it
 * must run every gate so post-verify's diff-scoped subset is a subset of what pre already ran
 * (like-vs-like per gate, HARNESS-PRINCIPLES § 9).
 */
export const runPreVerifyGate = (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  signal: AbortSignal | undefined
): Promise<RunVerifyScriptOutput> => {
  const gates = normalizeVerifyGates(opts.verifyScript, opts.verifyGates);
  return runVerifyGatesUseCase({
    cwd: opts.cwd,
    phase: 'pre',
    gates,
    mode: 'all-run',
    ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
    clock: deps.clock,
    // Thread the chain abort signal so a Ctrl-C mid-verify kills the child promptly instead of
    // stranding the repo lock for the full verifyTimeout. The runner now widens its error to
    // `StorageError | AbortError`; `runVerifyScriptUseCase` only knows `StorageError`, so
    // collapse an abort to a storage shape here (the runner has already killed the child) — the
    // real abort is surfaced verbatim by the `signal.aborted` check the caller runs immediately
    // after, before the folded spawn-error row is ever acted on.
    runShellScript: (cwd, script, scriptOpts) =>
      runVerifyShell(deps.shellScriptRunner, cwd, script, {
        ...scriptOpts,
        ...(signal !== undefined ? { signal } : {}),
      }),
    logger: deps.logger,
  });
};

/**
 * Deterministic stash message for {@link withReproductionTestExcluded}'s push/pop cycle below.
 * Created and popped synchronously within one pre-task-verify call, but a stable per-task message
 * keeps a failed pop recoverable via `git stash list` — mirrors every other quarantine message in
 * this chain (`quarantineStashMessage`, `retryStashMessage`).
 *
 * @public
 */
export const reproductionExcludeStashMessage = (sprintId: SprintId, taskId: TaskId): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/reproduction-baseline-exclude`;

/**
 * True iff `path` itself carries uncommitted changes (modified OR untracked) — a porcelain probe
 * scoped to that ONE path so {@link withReproductionTestExcluded} only stashes when there is
 * something to exclude: never on a path that is already committed-and-clean, and never on one an
 * earlier quarantine already swept out of the tree. A probe failure demotes to "nothing to
 * exclude" so the caller always falls through to running the gate on the untouched tree.
 */
const isPathDirty = async (runner: GitRunner, cwd: AbsolutePath, path: string): Promise<boolean> => {
  const status = await runner.run(cwd, ['status', '--porcelain', '--', path]);
  return status.ok && status.value.exitCode === 0 && status.value.stdout.trim().length > 0;
};

/**
 * Exclude the harness-authored reproduction test from the pre-verify BASELINE by stashing exactly
 * that one path around the gate run, then restoring it — every time this leaf runs the real gate,
 * not just on the task's first attempt.
 *
 * The problem this closes (confirmed[9]): `reproduceLeaf` (see `reproduce.ts`) deliberately leaves
 * a FAILING test uncommitted in the working tree before the attempt loop starts. `runPreVerifyGate`
 * runs with NO scope — the complete gate — so on every defect-shaped task's every attempt the
 * baseline was always red, and `attributeVerify` (`run-verify-script.ts`) could then only ever
 * land on `'baseline-broken'` — the one attribution the harness treats as "not the AI's fault,
 * don't block" (`post-task-verify.ts`'s `shouldBlock = isRed && attribution !== 'baseline-broken'`)
 * — regardless of whether the attempt's fix was actually correct. That masks a genuinely broken
 * fix as a pre-existing failure and lets it commit on red, defeating never-commit-on-red for an
 * entire class of tasks. Excluding the test's own path restores the real question pre-verify
 * exists to answer: was the tree healthy BEFORE this attempt's AI work, independent of the fixture
 * the harness itself just added — so a healthy repo now correctly reads `pre=success`, and a
 * broken fix now correctly reads `post=failed` against that green baseline → `'regressed'`, which
 * blocks (or retries within budget) instead of silently committing.
 *
 * Reapplied on EVERY attempt rather than cached from the first: each attempt gets its own
 * independent pre/post pair, so a stale attempt-1 baseline would silently mis-attribute attempt 2+
 * (e.g. after the tree picked up a partial diff from a retried attempt).
 *
 * Best-effort, mirroring every other stash-based quarantine in this chain: a failed push falls
 * through to running the gate WITH the test present — the shape the leaf had before this mechanism
 * existed, imperfect but non-corrupting. A failed pop is logged at `error` (the file is still
 * recoverable via `git stash list`, named in the message) rather than failing the leaf — turning a
 * forensic-recovery situation into a hard chain failure over one file would be a worse outcome than
 * the operator restoring it by hand.
 *
 * @public
 */
export const withReproductionTestExcluded = async <T>(
  deps: Pick<PreTaskVerifyLeafDeps, 'gitRunner' | 'logger'>,
  cwd: AbsolutePath,
  sprintId: SprintId,
  taskId: TaskId,
  testPath: string | undefined,
  run: () => Promise<T>
): Promise<T> => {
  if (testPath === undefined) return run();

  const log = deps.logger.named('implement.pre-task-verify');
  const dirty = await isPathDirty(deps.gitRunner, cwd, testPath);
  if (!dirty) return run();

  const message = reproductionExcludeStashMessage(sprintId, taskId);
  const pushed = await deps.gitRunner.run(cwd, ['stash', 'push', '-u', '-m', message, '--', testPath]);
  if (!pushed.ok || pushed.value.exitCode !== 0) {
    log.warn('reproduction-test exclude stash failed — pre-verify baseline includes the reproduction test', {
      taskId: String(taskId),
      testPath,
    });
    return run();
  }

  try {
    return await run();
  } finally {
    const popped = await gitStashPop(deps.gitRunner, cwd, message);
    if (!popped.ok || !popped.value.popped) {
      log.error(
        'reproduction-test exclude stash pop failed — the reproduction test may be missing from the working tree',
        { taskId: String(taskId), testPath, stashMessage: message }
      );
    }
  }
};

/**
 * Appends the row to the running attempt. A red baseline also stamps `baselineBroken` so the TUI
 * can warn the operator. `spawn-error` leaves `baselineBroken` unset — the baseline state is
 * unknown, not known-bad. Persists so the audit row survives a crash — a persistence failure is
 * logged but non-fatal, the chain has already captured the meaningful side effect (the script
 * ran); losing the audit at most causes a re-record on the next resume.
 */
export const appendAndPersistPreVerifyRun = async (
  deps: PreTaskVerifyLeafDeps,
  input: LeafInput,
  taskId: TaskId,
  run: VerifyRun
): Promise<Result<InProgressTask, DomainError>> => {
  let updated = appendAttemptVerifyRun(input.task, run);
  if (!updated.ok) return Result.error(updated.error);
  if (run.outcome === 'failed') {
    const flagged = markAttemptBaselineBroken(updated.value);
    if (!flagged.ok) return Result.error(flagged.error);
    updated = flagged;
  }

  const persisted = await deps.taskRepo.update(input.sprintId, updated.value);
  if (!persisted.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `pre-task-verify audit persist failed for task ${String(taskId)} — ${persisted.error.message}`,
      at: deps.clock(),
    });
  }
  return Result.ok(updated.value);
};

/**
 * Handles a red (`outcome === 'failed'`) pre-verify. Prior in-sprint amnesty falls through
 * silently with the warning banner. Non-interactive context hard-blocks (the operator can't
 * answer; silently running AI on broken state is the surprising behaviour the gate exists to
 * prevent). Interactive context asks the operator to proceed / skip / abort, persisting the
 * "proceed" amnesty so the rest of the sprint's tasks don't re-prompt.
 */
export const handleRedBaseline = async (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  env: PreTaskVerifyEnvironment,
  taskId: TaskId,
  updatedTask: InProgressTask,
  run: VerifyRun,
  execution: SprintExecution
): Promise<Result<LeafOutput, DomainError>> => {
  // Prior in-sprint amnesty — fall through silently with today's warning banner.
  if (execution.baselineBrokenPolicy === 'proceed') {
    emitBaselineRedLog(deps, opts, run);
    emitBaselineRedBanner(deps, taskId);
    return Result.ok({ task: updatedTask, run, execution });
  }

  // Non-interactive context — hard-block. The operator can't answer; silently running AI on
  // broken state is the surprising behaviour the gate exists to prevent.
  if (!isInteractive(env)) {
    const reason = 'baseline already red at task start (non-interactive — operator could not be prompted)';
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `pre-task-verify ${String(opts.cwd)}: ${reason}`,
      at: deps.clock(),
    });
    return Result.ok({ task: updatedTask, run, execution, blockReason: reason });
  }

  // Interactive context, no prior amnesty — ask the operator.
  const decision = await askRedBaselineDecision(deps.interactive, opts.cwd, run.exitCode);
  if (!decision.ok) return Result.error(decision.error);
  if (decision.value === 'abort') {
    return Result.error(
      new AbortError({
        elementName: `pre-task-verify-${String(taskId)}`,
        reason: 'operator aborted sprint on broken baseline',
      })
    );
  }
  if (decision.value === 'skip') {
    const reason = 'operator skipped task on broken baseline';
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `pre-task-verify ${String(opts.cwd)}: ${reason}`,
      at: deps.clock(),
    });
    return Result.ok({ task: updatedTask, run, execution, blockReason: reason });
  }
  // decision.value === 'proceed' — persist the amnesty so the rest of the sprint's tasks don't
  // re-prompt, then fall through to today's warning banner.
  const nextExecution = setExecutionBaselineBrokenPolicy(execution, 'proceed');
  const saved = await deps.sprintExecutionRepo.save(nextExecution);
  if (!saved.ok) return Result.error(saved.error);
  emitBaselineRedLog(deps, opts, run);
  emitBaselineRedBanner(deps, taskId);
  return Result.ok({ task: updatedTask, run, execution: nextExecution });
};

/**
 * Handles a non-failed (`spawn-error` or `success`) pre-verify. A spawn-error is logged and
 * attribution is skipped downstream. A green pre-verify clears any stale baseline-broken banner
 * from a prior attempt of this same task (no-op when no such banner exists) and clears a
 * one-shot "proceed" amnesty so a fresh red later in the sprint re-prompts rather than silently
 * proceeding.
 */
export const handleNonFailedOutcome = async (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  taskId: TaskId,
  run: VerifyRun,
  execution: SprintExecution,
  spawnErrorMessage: string | undefined
): Promise<Result<SprintExecution, DomainError>> => {
  if (run.outcome === 'spawn-error') {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `pre-task-verify ${String(opts.cwd)}: spawn-error — ${spawnErrorMessage ?? 'unknown spawn error'}; attribution will be skipped`,
      at: deps.clock(),
    });
    return Result.ok(execution);
  }

  deps.eventBus.publish({
    type: 'banner-clear',
    id: `baseline-broken-${String(taskId)}`,
    at: deps.clock(),
  });
  if (execution.baselineBrokenPolicy === 'proceed') {
    const nextExecution = setExecutionBaselineBrokenPolicy(execution, undefined);
    const saved = await deps.sprintExecutionRepo.save(nextExecution);
    if (!saved.ok) return Result.error(saved.error);
    return Result.ok(nextExecution);
  }
  return Result.ok(execution);
};

/**
 * Synthetic green `phase: 'pre'` {@link VerifyRun} — the shared shape both short-circuit paths
 * (carry-baseline and fresh-setup) return so downstream attribution and the T4 PRE_VERIFY_RESULTS
 * rendering see an identical baseline regardless of which skip fired. `command: ''` /
 * `durationMs: 0` mark it as not-spawned; the contract is the leaf's only (no audit row appended,
 * `lastPreVerifyOutcome` carries `'success'`).
 */
export const syntheticGreenPreRun = (clock: () => IsoTimestamp): VerifyRun => ({
  phase: 'pre',
  ranAt: clock(),
  command: '',
  exitCode: 0,
  durationMs: 0,
  outcome: 'success',
});

const emitBaselineRedLog = (
  deps: Pick<PreTaskVerifyLeafDeps, 'eventBus' | 'clock'>,
  opts: Pick<PreTaskVerifyLeafOpts, 'cwd'>,
  run: VerifyRun
): void => {
  deps.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `pre-task-verify ${String(opts.cwd)}: baseline already red (exit=${String(run.exitCode)}) — task will start on broken baseline`,
    at: deps.clock(),
  });
};

const emitBaselineRedBanner = (deps: Pick<PreTaskVerifyLeafDeps, 'eventBus' | 'clock'>, taskId: TaskId): void => {
  deps.eventBus.publish({
    type: 'banner-show',
    id: `baseline-broken-${String(taskId)}`,
    tier: 'warn',
    message: 'Pre-task verify baseline is red — task started on broken state',
    cause: `task ${String(taskId)}`,
    at: deps.clock(),
  });
};

/**
 * Adapter between the abort-aware {@link ShellScriptRunner} (which now widens its error to
 * `StorageError | AbortError`) and `runVerifyScriptUseCase`, whose `runShellScript` port still
 * declares a `StorageError`-only error. The runner has already killed the child by the time an
 * abort surfaces here, so collapsing the `AbortError` to a `StorageError` shape loses nothing —
 * the leaf re-derives the real cancellation from `signal.aborted` immediately after the call and
 * surfaces a verbatim `AbortError`, before the folded spawn-error row is ever acted on. Shared by
 * the pre- and post-task verify leaves so both thread the signal identically.
 *
 * @public
 */
export const runVerifyShell = async (
  runner: ShellScriptRunner,
  cwd: AbsolutePath,
  script: string,
  opts: ShellRunOptions
): Promise<Result<ShellScriptResult, StorageError>> => {
  const res = await runner.run(cwd, script, opts);
  if (res.ok) return Result.ok(res.value);
  if (res.error.code === ErrorCode.Aborted) {
    return Result.error(new StorageError({ subCode: 'io', message: res.error.message, cause: res.error }));
  }
  return Result.error(res.error);
};
