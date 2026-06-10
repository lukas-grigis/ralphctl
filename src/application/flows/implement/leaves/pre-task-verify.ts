import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import { normalizeVerifyGates, runVerifyGatesUseCase } from '@src/business/task/run-verify-script.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { appendAttemptVerifyRun, markAttemptBaselineBroken } from '@src/domain/entity/task-attempts.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { setExecutionBaselineBrokenPolicy, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellRunOptions, ShellScriptResult, ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { gitHasUncommittedChanges } from '@src/integration/io/git-operations.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Pre-task verify gate. Runs the project's `verifyScript` BEFORE the AI's generator turn and
 * records the result as a `phase: 'pre'` row on the running attempt. Captures the baseline
 * state of the working tree so the matching post-task-verify leaf can attribute correctly:
 *
 *   - pre=green, post=red → AI regressed a green baseline (blame this attempt).
 *   - pre=red,  post=red → pre-existing failure (don't blame the AI, warn instead).
 *   - pre=red,  post=green → AI repaired a pre-existing failure (credit it).
 *
 * Red-baseline interactive gate. A red pre-verify no longer falls through silently — the leaf
 * asks the operator whether to **proceed** on the broken tree, **skip** the task, or **abort**
 * the sprint. Decisions persist on `SprintExecution.baselineBrokenPolicy` ("proceed" only) so
 * the rest of the sprint's tasks don't re-prompt after the operator already opted in for this
 * red stretch; the policy clears back to undefined on the next green pre-verify so a fresh
 * red later in the sprint re-prompts.
 *
 * Non-interactive context (CI, RALPHCTL_NO_TUI, non-TTY stdin) hard-blocks the task by
 * default — the operator can't answer, and silently running AI on broken state is the
 * surprising behaviour the gate is meant to prevent. The operator can re-run interactively
 * once the baseline is fixed.
 *
 * A spawn-error pre-verify is recorded but treated as unknown-state — no prompt, no
 * `baselineBroken` flag, attribution skipped downstream.
 *
 * Persistence: the leaf calls `taskRepo.update` so the `verifyRuns` row survives a chain
 * crash mid-attempt. If persistence fails the chain still continues (logged warn) — the
 * pre-verify outcome is the value, not the audit save.
 */

export interface PreTaskVerifyLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly taskRepo: UpdateTask;
  /**
   * Used to persist the "proceed" amnesty when the operator opts in (and to clear it on the
   * next green pre-verify). Save semantics on the existing port are upsert, so a single
   * write rewrites the execution.json with the new policy field.
   */
  readonly sprintExecutionRepo: Save<SprintExecution>;
  /**
   * Used on a red pre-verify (when no amnesty is already in force) to ask the operator
   * whether to proceed / skip / abort. Only consulted in interactive context — non-interactive
   * runs hard-block before reaching the prompt.
   */
  readonly interactive: InteractivePrompt;
  /**
   * Used by the carry-baseline short-circuit at the top of `execute()`: when the previous
   * task's `post-task-verify` ran green on the same cwd, this leaf re-checks the working
   * tree via `git status --porcelain` and skips the verify script if the tree is clean.
   * Errors from the git probe demote to "ineligible" and fall through to the real script —
   * never propagated.
   */
  readonly gitRunner: GitRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  /**
   * Optional test seam — defaults to `process` so production uses the real stdin / env. Tests
   * inject a stub to drive interactive vs non-interactive paths deterministically without
   * mutating the global process object.
   */
  readonly environment?: PreTaskVerifyEnvironment;
}

/**
 * Narrow surface the leaf needs from the process environment to detect interactive context.
 * Spelled out so tests can inject a stub instead of touching `process.stdin` / `process.env`.
 */
export interface PreTaskVerifyEnvironment {
  readonly isStdinTty: boolean;
  readonly isCi: boolean;
  readonly isNoTui: boolean;
}

const defaultEnvironment = (): PreTaskVerifyEnvironment => ({
  isStdinTty: process.stdin.isTTY === true,
  isCi: isTruthyEnv(process.env.CI),
  isNoTui: isTruthyEnv(process.env.RALPHCTL_NO_TUI),
});

const isTruthyEnv = (raw: string | undefined): boolean => raw !== undefined && raw !== '' && raw !== '0';

const isInteractive = (env: PreTaskVerifyEnvironment): boolean => env.isStdinTty && !env.isCi && !env.isNoTui;

export interface PreTaskVerifyLeafOpts {
  readonly cwd: AbsolutePath;
  readonly verifyScript?: string;
  /**
   * Structured per-module verify gates (WS3). When present AND non-empty, the leaf runs THESE via
   * the multi-gate executor in `all-run` mode (no diff scope) — the baseline snapshot needs the
   * COMPLETE picture so post-verify's scoped subset compares like-vs-like per gate. Absent → the
   * leaf normalises `verifyScript` to a single catch-all gate, so one code path runs everything.
   */
  readonly verifyGates?: readonly VerifyGate[];
  readonly timeoutMs?: number;
  /**
   * Per-sprint state directory. When set, the leaf writes the full untruncated verify-script
   * output to `<sprintDir>/logs/verify/<task-id>/pre-attempt-<N>.log` per audit [01] / [03].
   */
  readonly sprintDir?: AbsolutePath;
  /**
   * Opt-in fresh-setup skip (`settings.harness.skipPreVerifyOnFreshSetup`, default `false`).
   * When `true`, the FIRST pre-verify of a run on this repo synthesizes a green baseline —
   * instead of re-running the verify gate — provided this launch's setup script verified the
   * same repo green (`ctx.setupVerifiedRepoIdsThisRun` contains the task's repo id) AND the
   * working tree is clean. Tasks 2..N are already covered by the carry-baseline short-circuit
   * (they carry a green post-verify from the prior task), so this branch only fires when no
   * such carry is available. Off → the leaf always runs the real verify gate.
   */
  readonly skipPreVerifyOnFreshSetup?: boolean;
}

interface LeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly execution: SprintExecution;
  /**
   * Carried from `ctx.priorPostVerifyOutcome` — the previous task's post-task-verify result
   * (cwd + outcome). Drives the carry-baseline short-circuit: when `outcome === 'success'`
   * and the cwd matches `opts.cwd` and the working tree is clean, the leaf returns a
   * synthetic green {@link VerifyRun} without spawning the verify script.
   */
  readonly priorPostVerifyOutcome?: { readonly cwd: AbsolutePath; readonly outcome: VerifyRunOutcome };
  /**
   * The in-flight task's repository id (`ctx.currentTask.repositoryId`). Matched against
   * {@link setupVerifiedRepoIds} to decide the fresh-setup skip — keyed on repo id, not cwd, so
   * the parallel path (worktree path ≠ setup path, same repo id) takes the skip too.
   */
  readonly repositoryId: RepositoryId;
  /**
   * Carried from `ctx.setupVerifiedRepoIdsThisRun` — the repos this launch's setup verified
   * green. Drives the fresh-setup short-circuit when {@link PreTaskVerifyLeafOpts.skipPreVerifyOnFreshSetup}
   * is on and no prior-task carry is available.
   */
  readonly setupVerifiedRepoIds?: readonly RepositoryId[];
}

interface LeafOutput {
  readonly task: InProgressTask;
  readonly run: VerifyRun;
  /**
   * The execution after any policy mutation the leaf made (set to 'proceed' on opt-in;
   * cleared on green). Returned so the ctx projection can replace `ctx.execution` and the
   * next task's pre-task-verify sees the up-to-date policy without re-reading from disk.
   */
  readonly execution: SprintExecution;
  /**
   * Set when the leaf decided to short-circuit the task — non-interactive hard-block, or
   * operator picked "skip task". The projection lifts these onto `ctx.lastExit` /
   * `ctx.lastBlockReason` so the gen-eval loop's `shouldStop` predicate fires before any AI
   * spawn and finalize-gen-eval routes the task to `blocked`. Undefined on the happy path
   * (operator picked "proceed", or pre-verify was green / spawn-error / skipped).
   */
  readonly blockReason?: string;
}

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

export const preTaskVerifyLeaf = (
  deps: PreTaskVerifyLeafDeps,
  opts: PreTaskVerifyLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const env = deps.environment ?? defaultEnvironment();
  return leaf<ImplementCtx, LeafInput, LeafOutput>(`pre-task-verify-${String(taskId)}`, {
    useCase: {
      execute: async (input, signal): Promise<Result<LeafOutput, DomainError>> => {
        // Carry-baseline short-circuit. When the previous task on this same cwd post-verified
        // green and the working tree is still clean, the script's outcome can only be the
        // same — re-running it is wasted compute (~2m30s on a typical repo). Skip the script,
        // skip the audit-row append (no extra `phase: 'pre'` row), skip the log file write,
        // skip the prompt. The synthetic `VerifyRun` we return is for the leaf's contract
        // only — `lastPreVerifyOutcome` correctly carries `'success'` through the output
        // projection so post-task-verify's attribution computation sees `pre=success`.
        //
        // Git status returning an error (corrupt repo, fs error) demotes to "ineligible" —
        // the real script runs instead, matching today's behavior verbatim.
        const carriedGreenForThisCwd =
          input.priorPostVerifyOutcome?.outcome === 'success' &&
          String(input.priorPostVerifyOutcome.cwd) === String(opts.cwd);
        if (carriedGreenForThisCwd) {
          const dirty = await gitHasUncommittedChanges(deps.gitRunner, opts.cwd);
          if (dirty.ok && !dirty.value) {
            deps.eventBus.publish({
              type: 'log',
              level: 'info',
              message: `pre-task-verify ${String(opts.cwd)}: short-circuited (carried green baseline, tree clean)`,
              at: deps.clock(),
            });
            return Result.ok({ task: input.task, run: syntheticGreenPreRun(deps.clock), execution: input.execution });
          }
          // Dirty tree, or git probe failed — fall through to the real verify path. Don't
          // surface the git-status error: the operator gets the existing behavior, not a
          // regression.
        }

        // Fresh-setup short-circuit (T13) — a strict generalisation of the carry-baseline path
        // above, for the FIRST pre-verify of the run on this repo. The carry path only seeds from a
        // PRIOR TASK's green post-verify, so the first task of every launch always re-ran the gate
        // even when this launch's setup script just built+tested the same tree seconds earlier.
        // When the operator has opted in (`skipPreVerifyOnFreshSetup`), this launch's setup verified
        // this repo green (the run-scoped marker — NOT a persisted prior-launch success), and the
        // tree is clean, synthesize the SAME green baseline so downstream attribution + the
        // PRE_VERIFY_RESULTS rendering fold to the identical path. Gated on the carry being absent so
        // the two short-circuits never overlap — once a task has post-verified green, the carry path
        // owns the subsequent skip.
        if (
          opts.skipPreVerifyOnFreshSetup === true &&
          !carriedGreenForThisCwd &&
          (input.setupVerifiedRepoIds ?? []).some((id) => String(id) === String(input.repositoryId))
        ) {
          const dirty = await gitHasUncommittedChanges(deps.gitRunner, opts.cwd);
          if (dirty.ok && !dirty.value) {
            deps.eventBus.publish({
              type: 'log',
              level: 'info',
              message: `pre-task-verify ${String(opts.cwd)}: short-circuited (this run's setup verified the tree green, tree clean)`,
              at: deps.clock(),
            });
            return Result.ok({ task: input.task, run: syntheticGreenPreRun(deps.clock), execution: input.execution });
          }
          // Dirty tree or git probe failed — fall through to the real verify gate (same demotion
          // policy as the carry path: never surface the git-status error as a regression).
        }

        // Normalise legacy script + structured gates into ONE gate list (gates win when present),
        // then run the FULL set with NO scope — `all-run` mode. Pre-verify is the attribution
        // baseline; it must run every gate so post-verify's diff-scoped subset is a subset of what
        // pre already ran (like-vs-like per gate, HARNESS-PRINCIPLES § 9).
        const gates = normalizeVerifyGates(opts.verifyScript, opts.verifyGates);
        const { run, rawOutput, spawnErrorMessage } = await runVerifyGatesUseCase({
          cwd: opts.cwd,
          phase: 'pre',
          gates,
          mode: 'all-run',
          ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
          clock: deps.clock,
          // Thread the chain abort signal so a Ctrl-C mid-verify kills the child promptly instead
          // of stranding the repo lock for the full verifyTimeout. The runner now widens its
          // error to `StorageError | AbortError`; `runVerifyScriptUseCase` only knows
          // `StorageError`, so collapse an abort to a storage shape here (the runner has already
          // killed the child) — the real abort is surfaced verbatim by the `signal.aborted` check
          // below, before the folded spawn-error row is ever acted on.
          runShellScript: (cwd, script, scriptOpts) =>
            runVerifyShell(deps.shellScriptRunner, cwd, script, {
              ...scriptOpts,
              ...(signal !== undefined ? { signal } : {}),
            }),
          logger: deps.logger,
        });

        // Cancellation propagates verbatim. `runVerifyScriptUseCase` folds a runner
        // `Result.error` into a `spawn-error` row, so the abort would otherwise be swallowed as an
        // unknown-baseline outcome. Detect the cancel at the leaf boundary and surface the
        // codebase's transparently-propagated `AbortError` instead — the chain tears down rather
        // than recording a misleading spawn-error and starting the AI on a half-verified tree.
        if (signal?.aborted === true) {
          return Result.error(
            new AbortError({
              elementName: `pre-task-verify-${String(taskId)}`,
              reason: 'aborted during pre-task verify',
            })
          );
        }

        // Audit [01] / [03]: persist the full untruncated output to
        // `<sprintDir>/logs/verify/<task-id>/pre-attempt-<N>.log`. Best-effort — write
        // failures log warn and never abort the chain.
        if (opts.sprintDir !== undefined && rawOutput.length > 0) {
          const attemptN = input.task.attempts.length;
          const logPath = join(
            String(opts.sprintDir),
            'logs',
            'verify',
            String(input.task.id),
            `pre-attempt-${String(attemptN)}.log`
          );
          const wrote = await writeTextAtomic(logPath, rawOutput);
          if (!wrote.ok) {
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `pre-task-verify ${String(opts.cwd)}: failed to persist full log to ${logPath} — ${wrote.error.message}`,
              at: deps.clock(),
            });
          }
        }

        // Append the row to the running attempt. A red baseline also stamps `baselineBroken`
        // so the TUI can warn the operator. `spawn-error` leaves `baselineBroken` unset —
        // the baseline state is unknown, not known-bad.
        let updated = appendAttemptVerifyRun(input.task, run);
        if (!updated.ok) return Result.error(updated.error);
        if (run.outcome === 'failed') {
          const flagged = markAttemptBaselineBroken(updated.value);
          if (!flagged.ok) return Result.error(flagged.error);
          updated = flagged;
        }

        // Persist so the audit row survives a crash. A persistence failure is logged but
        // non-fatal — the chain has already captured the meaningful side effect (the script
        // ran); losing the audit at most causes a re-record on the next resume.
        const persisted = await deps.taskRepo.update(input.sprintId, updated.value);
        if (!persisted.ok) {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `pre-task-verify audit persist failed for task ${String(taskId)} — ${persisted.error.message}`,
            at: deps.clock(),
          });
        }

        let execution = input.execution;

        if (run.outcome === 'failed') {
          // Prior in-sprint amnesty — fall through silently with today's warning banner.
          if (execution.baselineBrokenPolicy === 'proceed') {
            emitBaselineRedLog(deps, opts, run);
            emitBaselineRedBanner(deps, taskId);
            return Result.ok({ task: updated.value, run, execution });
          }

          // Non-interactive context — hard-block. The operator can't answer; silently running
          // AI on broken state is the surprising behaviour the gate exists to prevent.
          if (!isInteractive(env)) {
            const reason = 'baseline already red at task start (non-interactive — operator could not be prompted)';
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `pre-task-verify ${String(opts.cwd)}: ${reason}`,
              at: deps.clock(),
            });
            return Result.ok({ task: updated.value, run, execution, blockReason: reason });
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
            return Result.ok({ task: updated.value, run, execution, blockReason: reason });
          }
          // decision.value === 'proceed' — persist the amnesty so the rest of the sprint's
          // tasks don't re-prompt, then fall through to today's warning banner.
          const nextExecution = setExecutionBaselineBrokenPolicy(execution, 'proceed');
          const saved = await deps.sprintExecutionRepo.save(nextExecution);
          if (!saved.ok) return Result.error(saved.error);
          execution = nextExecution;
          emitBaselineRedLog(deps, opts, run);
          emitBaselineRedBanner(deps, taskId);
          return Result.ok({ task: updated.value, run, execution });
        }

        if (run.outcome === 'spawn-error') {
          deps.eventBus.publish({
            type: 'log',
            level: 'warn',
            message: `pre-task-verify ${String(opts.cwd)}: spawn-error — ${spawnErrorMessage ?? 'unknown spawn error'}; attribution will be skipped`,
            at: deps.clock(),
          });
        } else {
          // Green pre-verify — clear any stale baseline-broken banner from a prior attempt of
          // this same task. No-op when no such banner exists.
          deps.eventBus.publish({
            type: 'banner-clear',
            id: `baseline-broken-${String(taskId)}`,
            at: deps.clock(),
          });
          // Amnesty is one-shot: once the baseline turns green again, clear the policy so a
          // fresh red later in the sprint re-prompts rather than silently proceeding.
          if (execution.baselineBrokenPolicy === 'proceed') {
            const nextExecution = setExecutionBaselineBrokenPolicy(execution, undefined);
            const saved = await deps.sprintExecutionRepo.save(nextExecution);
            if (!saved.ok) return Result.error(saved.error);
            execution = nextExecution;
          }
        }

        return Result.ok({ task: updated.value, run, execution });
      },
    },
    input: (ctx) => {
      if (ctx.currentTask === undefined || ctx.currentTask.id !== taskId) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-pre-task-verify',
          attemptedAction: `pre-task-verify-${String(taskId)}`,
          message: `pre-task-verify-${String(taskId)}: ctx.currentTask is missing or mismatched`,
        });
      }
      if (ctx.currentTask.status !== 'in_progress') {
        throw new InvalidStateError({
          entity: 'task',
          currentState: ctx.currentTask.status,
          attemptedAction: `pre-task-verify-${String(taskId)}`,
          message: `pre-task-verify-${String(taskId)}: expected in_progress task — got '${ctx.currentTask.status}'`,
        });
      }
      if (ctx.execution === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-pre-task-verify',
          attemptedAction: `pre-task-verify-${String(taskId)}`,
          message: `pre-task-verify-${String(taskId)}: ctx.execution is undefined — load-sprint-execution must run first`,
        });
      }
      return {
        task: ctx.currentTask,
        sprintId: ctx.sprintId,
        execution: ctx.execution,
        repositoryId: ctx.currentTask.repositoryId,
        ...(ctx.priorPostVerifyOutcome !== undefined ? { priorPostVerifyOutcome: ctx.priorPostVerifyOutcome } : {}),
        ...(ctx.setupVerifiedRepoIdsThisRun !== undefined
          ? { setupVerifiedRepoIds: ctx.setupVerifiedRepoIdsThisRun }
          : {}),
      };
    },
    output: (ctx, out) => {
      const next: ImplementCtx = {
        ...ctx,
        currentTask: out.task,
        tasks: (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t)),
        execution: out.execution,
        lastPreVerifyOutcome: out.run.outcome,
      };
      // When the leaf decided to short-circuit the task (non-interactive block or skip), lift
      // the reason onto `lastExit` + `lastBlockReason`. The gen-eval loop's `shouldContinue`
      // predicate sees `lastExit !== undefined` at loop entry and REFUSES to enter any turn —
      // no round folder is claimed, no meta sidecar is stamped, and the generator never spawns
      // on the broken tree the gate just refused. finalize-gen-eval then reads the self-blocked
      // exit and stamps `verdict: 'failed'` + `blockedReason` so settle-attempt routes the task
      // to `blocked`. post-task-verify also short-circuits to a synthetic `'skipped'` run
      // (`lastBlockReason` set AND `genEvalTurn === undefined`) so the dominant-cost verify
      // script is not re-run when there was no AI work to verify. Self-blocked is the existing
      // GenEvalExit kind that already carries an arbitrary reason string — there's no need for a
      // separate `baseline-broken` exit kind to wire the same outcome.
      if (out.blockReason !== undefined) {
        return {
          ...next,
          lastExit: { kind: 'self-blocked', reason: out.blockReason },
          lastBlockReason: out.blockReason,
        };
      }
      return next;
    },
  });
};

/**
 * Synthetic green `phase: 'pre'` {@link VerifyRun} — the shared shape both short-circuit paths
 * (carry-baseline and fresh-setup) return so downstream attribution and the T4 PRE_VERIFY_RESULTS
 * rendering see an identical baseline regardless of which skip fired. `command: ''` /
 * `durationMs: 0` mark it as not-spawned; the contract is the leaf's only (no audit row appended,
 * `lastPreVerifyOutcome` carries `'success'`).
 */
const syntheticGreenPreRun = (clock: () => IsoTimestamp): VerifyRun => ({
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
