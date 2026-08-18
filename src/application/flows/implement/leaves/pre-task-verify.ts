import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyRun, VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import type { VerifyGate } from '@src/domain/entity/repository.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  appendAndPersistPreVerifyRun,
  handleNonFailedOutcome,
  handleRedBaseline,
  isCarriedGreenForThisCwd,
  runPreVerifyGate,
  tryCarryBaselineShortCircuit,
  tryFreshSetupShortCircuit,
  withReproductionTestExcluded,
} from '@src/application/flows/implement/leaves/pre-task-verify-internals/verify-execution.ts';
import { persistPreVerifyLog } from '@src/application/flows/implement/leaves/pre-task-verify-internals/output-capping.ts';

// Re-exported so `post-task-verify.ts` (which shares the abort-aware shell adapter) keeps
// importing it from this leaf's public surface — the definition itself now lives in
// `pre-task-verify-internals/verify-execution.ts` alongside the rest of the execution logic.
export { runVerifyShell } from '@src/application/flows/implement/leaves/pre-task-verify-internals/verify-execution.ts';

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
  /**
   * Atomic whole-file writer for the persisted verify log — see `persistPreVerifyLog` in
   * `pre-task-verify-internals/output-capping.ts`. Optional: callers that don't wire the port
   * fall back to the direct `writeTextAtomic` adapter via that module's `defaultWriteFile`, so
   * behaviour is unchanged either way.
   */
  readonly writeFile?: WriteFile;
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

export interface LeafInput {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly execution: SprintExecution;
  /**
   * Carried from `ctx.priorPostVerifyOutcome` — the previous task's post-task-verify result
   * (cwd + outcome + gate coverage). Drives the carry-baseline short-circuit: when
   * `outcome === 'success'` AND that run executed every configured gate (`coveredAllGates`)
   * and the cwd matches `opts.cwd` and the working tree is clean, the leaf returns a synthetic
   * green {@link VerifyRun} without spawning the verify script. A diff-scoped post run (or a
   * ctx from before the flag existed) is not whole-tree evidence and falls through.
   */
  readonly priorPostVerifyOutcome?: {
    readonly cwd: AbsolutePath;
    readonly outcome: VerifyRunOutcome;
    readonly coveredAllGates?: boolean;
  };
  /**
   * The in-flight task's repository id (`ctx.currentTask.repositoryId`). Matched against
   * {@link LeafInput.setupVerifiedRepoIds} to decide the fresh-setup skip — keyed on repo id, not
   * cwd, so the parallel path (worktree path ≠ setup path, same repo id) takes the skip too.
   */
  readonly repositoryId: RepositoryId;
  /**
   * Carried from `ctx.setupVerifiedRepoIdsThisRun` — the repos this launch's setup verified
   * green. Drives the fresh-setup short-circuit when {@link PreTaskVerifyLeafOpts.skipPreVerifyOnFreshSetup}
   * is on and no prior-task carry is available.
   */
  readonly setupVerifiedRepoIds?: readonly RepositoryId[];
  /**
   * Carried from `ctx.reproductionArtifact.testPath` — the harness-authored reproduction test the
   * guarded `reproduce-<taskId>` leaf left uncommitted in the tree before the attempt loop (see
   * `reproduce.ts`). When set, the gate run below excludes exactly this path from the baseline
   * (see `withReproductionTestExcluded` in `pre-task-verify-internals/verify-execution.ts`) so a
   * defect-shaped task's deliberately-failing fixture cannot masquerade as a pre-existing broken
   * baseline. Undefined for a non-defect-shaped task (no reproduction was validated).
   */
  readonly reproductionTestPath?: string;
}

export interface LeafOutput {
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

/** Projects `ImplementCtx` onto the leaf's `LeafInput`, throwing on ctx-shape violations. */
const buildPreTaskVerifyInput = (ctx: ImplementCtx, taskId: TaskId): LeafInput => {
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
    ...(ctx.setupVerifiedRepoIdsThisRun !== undefined ? { setupVerifiedRepoIds: ctx.setupVerifiedRepoIdsThisRun } : {}),
    ...(ctx.reproductionArtifact !== undefined ? { reproductionTestPath: ctx.reproductionArtifact.testPath } : {}),
  };
};

/**
 * Projects the leaf's `LeafOutput` back onto `ImplementCtx`. When the leaf decided to
 * short-circuit the task (non-interactive block or skip), lifts the reason onto `ctx.lastExit` /
 * `ctx.lastBlockReason`. The gen-eval loop's `shouldContinue` predicate sees `lastExit !==
 * undefined` at loop entry and REFUSES to enter any turn — no round folder is claimed, no meta
 * sidecar is stamped, and the generator never spawns on the broken tree the gate just refused.
 * finalize-gen-eval then reads the self-blocked exit and stamps `verdict: 'failed'` +
 * `blockedReason` so settle-attempt routes the task to `blocked`. post-task-verify also
 * short-circuits to a synthetic `'skipped'` run (`lastBlockReason` set AND `genEvalTurn ===
 * undefined`) so the dominant-cost verify script is not re-run when there was no AI work to
 * verify. Self-blocked is the existing GenEvalExit kind that already carries an arbitrary reason
 * string — there's no need for a separate `baseline-broken` exit kind to wire the same outcome.
 */
const projectPreTaskVerifyOutput = (ctx: ImplementCtx, out: LeafOutput): ImplementCtx => {
  const next: ImplementCtx = {
    ...ctx,
    currentTask: out.task,
    tasks: (ctx.tasks ?? []).map((t) => (t.id === out.task.id ? (out.task as Task) : t)),
    execution: out.execution,
    lastPreVerifyOutcome: out.run.outcome,
  };
  if (out.blockReason !== undefined) {
    return {
      ...next,
      lastExit: { kind: 'self-blocked', reason: out.blockReason },
      lastBlockReason: out.blockReason,
    };
  }
  return next;
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
        const carriedGreenForThisCwd = isCarriedGreenForThisCwd(input, opts.cwd);

        const carried = await tryCarryBaselineShortCircuit(deps, opts, input, carriedGreenForThisCwd);
        if (carried !== undefined) return Result.ok(carried);

        const freshSetup = await tryFreshSetupShortCircuit(deps, opts, input, carriedGreenForThisCwd);
        if (freshSetup !== undefined) return Result.ok(freshSetup);

        // Exclude the reproduction test's own path from the baseline gate run (confirmed[9]) —
        // see `withReproductionTestExcluded`'s docstring for why this must reapply on every
        // attempt, not just the first.
        const { run, rawOutput, spawnErrorMessage } = await withReproductionTestExcluded(
          deps,
          opts.cwd,
          input.sprintId,
          taskId,
          input.reproductionTestPath,
          () => runPreVerifyGate(deps, opts, signal)
        );

        // Cancellation propagates verbatim. `runVerifyGatesUseCase` folds a runner
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

        await persistPreVerifyLog(deps, opts, input, rawOutput);

        const appended = await appendAndPersistPreVerifyRun(deps, input, taskId, run);
        if (!appended.ok) return Result.error(appended.error);

        if (run.outcome === 'failed') {
          return handleRedBaseline(deps, opts, env, taskId, appended.value, run, input.execution);
        }

        const executionResult = await handleNonFailedOutcome(
          deps,
          opts,
          taskId,
          run,
          input.execution,
          spawnErrorMessage
        );
        if (!executionResult.ok) return Result.error(executionResult.error);

        return Result.ok({ task: appended.value, run, execution: executionResult.value });
      },
    },
    input: (ctx) => buildPreTaskVerifyInput(ctx, taskId),
    output: projectPreTaskVerifyOutput,
  });
};
