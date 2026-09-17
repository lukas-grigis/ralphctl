import { basename } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  appendExecutionSetupRun,
  type SetupRun,
  type SetupTreeRecord,
  type SprintExecution,
} from '@src/domain/entity/sprint-execution.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptResult, ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { SetupTreeCheck, SetupTreeGuard } from '@src/application/flows/implement/leaves/setup-tree-guard.ts';
import {
  BANNER_SHOW,
  buildSetupFailureError,
  persistSetupLog,
} from '@src/application/flows/implement/leaves/setup-script-failure.ts';

/**
 * Harness-side setup-script gate. The leaf runs at the start of every implement chain —
 * once per affected repo — and the chain treats the result as the authoritative readiness
 * signal for the working tree. The AI session may *also* run `pnpm install` (etc.) from
 * inside its own prompt, but the harness is the source of truth: if the harness setup
 * fails, the chain hard-aborts before any task spins up.
 *
 * **New-sprint vs resume gate** (audit [04]): setup runs once per repo per sprint. The
 * gate uses `SprintExecution.setupRanAt` as the audit source. For each repo:
 *
 *   - If the repo's LATEST run is a success of the current `setupScript` AND — when a tree guard
 *     is wired — carries a complete post-setup working-tree answer (`SetupRun.tree`, not
 *     truncated) → skip this repo (resume path) and carry that answer forward. Log "skipped on
 *     resume" at info tier. `'skipped'` no-script rows don't count as runs (see
 *     {@link resumableSuccess}).
 *   - Otherwise → run the script (new path / a later failed or spawn-error run / command-drift
 *     retry / a success whose working-tree answer is missing — written before the answer was
 *     recorded, or its check was cancelled or failed — or incomplete).
 *
 * Rationale: setup is idempotent but slow; running `pnpm install` / `mvn dependency:go-offline`
 * on every implement resume burns 10-60s per repo for no gain. The first successful run
 * proves the tree builds; subsequent resumes trust that state.
 *
 * Command drift is treated as a new run: if the operator changes `project.json#setupScript`
 * between runs, the prior success is stale and the new command must be validated.
 *
 * The recorded answer is what makes resume safe for the parallel path: every task worktree runs
 * setup again on a fresh checkout and needs to know what the operator decided about that same
 * script's output in the main checkout. Re-running main setup on every relaunch would re-ask the
 * question each time; the durable answer asks it once per sprint.
 *
 * Outcomes (recorded one-per-repo on `SprintExecution.setupRanAt` when the script runs):
 *
 *   - `'skipped'`     — repo has no `setupScript` configured. Explicit no-op row.
 *   - `'success'`     — script ran and exited 0.
 *   - `'failed'`      — script spawned but exited non-zero. The chain aborts.
 *   - `'spawn-error'` — the shell could not start the command (missing binary, permission
 *                       denied, etc). `exitCode === -1`. The spawn error message lands on
 *                       the abort log / banner but is no longer persisted on the audit row
 *                       (Wave 8 / audit-[06]). The chain aborts.
 *
 * The resume-path skip does NOT append a new audit row; the prior success entry stays
 * canonical. Each fresh run appends one row.
 *
 * **Post-setup tree check**: the dirty-tree menu runs BEFORE this leaf, so dirt a script creates
 * (a rewritten lockfile, generated files that aren't ignored) would otherwise reach the first task
 * unannounced — swept into its commit by `git add -A`, or misread as a broken baseline. When the
 * flow injects a {@link SetupTreeGuard}, every script that actually spawns is bracketed by it: a
 * snapshot right before the spawn, and — only if the script exits green — a check that resolves
 * whatever the script introduced. The resume-skip and no-script paths spawn nothing, so they probe
 * nothing. The green run's audit row is written once the check settles, carrying its answer; a
 * check that errors or is cancelled leaves the row without one, so the next launch runs setup
 * again.
 *
 * Aborts surface as `Result.error(InvalidStateError)` from the use case; the chain framework
 * turns that into a failed trace entry and short-circuits the remaining elements.
 */

export interface SetupScriptRunnerLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly sprintExecutionRepo: Save<SprintExecution>;
  readonly logger: Logger;
  /** Atomic whole-file writer for the persisted setup log — see `persistSetupLog`. Optional. */
  readonly writeFile?: WriteFile;
  /**
   * Post-setup working-tree check — see {@link SetupTreeGuard}. The implement flow always wires
   * it; absent → scripts run unbracketed, record no working-tree answer, and a prior success
   * resume-skips without one.
   */
  readonly treeGuard?: SetupTreeGuard;
}

export interface SetupRepoEntry {
  readonly repositoryId: RepositoryId;
  readonly path: AbsolutePath;
  readonly setupScript?: string;
}

export interface SetupScriptRunnerLeafOpts {
  /** Every repo on the project. The leaf iterates this list, not the task-touched subset. */
  readonly repos: readonly SetupRepoEntry[];
  readonly timeoutMs?: number;
  /**
   * Per-sprint state directory. When set, the leaf writes the full untruncated setup-script
   * output to `<sprintDir>/logs/setup/<repo-id>.log` per audit [01] / [03]. The audit row
   * itself carries structured metadata only — operators read the full body from the log
   * file or via the `LogTailReader` port for lazy display. Absent → no file written (test
   * paths that don't care about disk logs still work).
   */
  readonly sprintDir?: AbsolutePath;
}

interface LeafInput {
  readonly execution: SprintExecution;
}

interface LeafOutput {
  readonly execution: SprintExecution;
  /**
   * Repository ids whose setup script ran green DURING THIS invocation. Excludes the
   * resume-skip path (whose success belongs to an earlier launch), the no-script `'skipped'`
   * path (nothing was validated), and repos whose script changed the working tree (the green
   * verdict described a tree the operator may since have stashed or reset). Lifted onto
   * `ctx.setupVerifiedRepoIdsThisRun` so the first pre-task-verify of the run can seed a green
   * baseline under `skipPreVerifyOnFreshSetup`.
   */
  readonly verifiedThisRun: readonly RepositoryId[];
  /**
   * Per repo, the post-setup working-tree answer — recorded by this invocation's check or carried
   * from the resume-skipped row. Lifted onto `ctx.setupTreeRecords`.
   */
  readonly treeRecords: ReadonlyMap<RepositoryId, SetupTreeRecord>;
}

/**
 * Resume gate: the success row a prior chain on this sprint left for this repo, when it still
 * stands for the current command — and, with a tree guard wired, carries the complete
 * working-tree answer the parallel worktrees need. Returns `undefined` when the script must run;
 * the previous success row stays canonical when it doesn't (no new row is appended).
 *
 * Only the repo's LATEST run counts: a failed or spawn-error run after a success may have left the
 * tree half-prepared (a script that deleted `node_modules` before failing), so the earlier success
 * no longer describes it. A `'skipped'` row is not a run — it records that no script was configured
 * at that launch, so nothing touched the tree, exactly like a resume-skip, which writes no row.
 */
const resumableSuccess = (
  execution: SprintExecution,
  repo: SetupRepoEntry,
  command: string,
  deps: SetupScriptRunnerLeafDeps
): SetupRun | undefined => {
  const latest = execution.setupRanAt.findLast(
    (r) => String(r.repositoryId) === String(repo.repositoryId) && r.outcome !== 'skipped'
  );
  if (latest === undefined) return undefined;
  const rerun = (reason: string): undefined => {
    deps.eventBus.publish({
      type: 'log',
      level: 'info',
      message: `setup-script ${String(repo.path)}: re-running — ${reason}`,
      at: deps.clock(),
    });
    return undefined;
  };
  if (latest.outcome !== 'success') {
    return rerun(`the last setup run on this sprint did not succeed (${latest.outcome}: ${latest.command})`);
  }
  if (latest.command !== command) {
    return rerun(`configured command changed since prior success (was: ${latest.command}, now: ${command})`);
  }
  if (deps.treeGuard !== undefined && latest.tree === undefined) {
    return rerun('no recorded working-tree check for the prior success');
  }
  if (deps.treeGuard !== undefined && latest.tree?.seenPathsTruncated === true) {
    return rerun('the recorded working-tree check is incomplete');
  }
  deps.eventBus.publish({
    type: 'log',
    level: 'info',
    message: `setup-script ${String(repo.path)}: skipped on resume (succeeded earlier on this sprint)`,
    at: deps.clock(),
  });
  return latest;
};

/**
 * No script configured is NOT a failure — the chain continues. But it is also not a silent
 * pass: the operator deserves to know that *nothing was validated* before the AI starts
 * touching the tree. Surface as a warn-tier banner (dismissible) and a warn-level log row so
 * it lands in both the Recent-log tail and the persistent chain.log. Banner id is repo-keyed
 * so re-runs replace rather than stack.
 */
const runNoScriptSkip = async (
  execution: SprintExecution,
  repo: SetupRepoEntry,
  deps: SetupScriptRunnerLeafDeps
): Promise<SprintExecution> => {
  const next = await persistRun(
    execution,
    {
      repositoryId: repo.repositoryId,
      ranAt: deps.clock(),
      command: '',
      exitCode: 0,
      durationMs: 0,
      outcome: 'skipped',
    },
    deps
  );
  deps.eventBus.publish({
    type: 'log',
    level: 'warn',
    message: `setup-script ${String(repo.path)}: skipped — no script configured (nothing was validated)`,
    at: deps.clock(),
  });
  deps.eventBus.publish({
    type: BANNER_SHOW,
    id: `setup-script-skipped-${String(repo.repositoryId)}`,
    tier: 'warn',
    message: `No setup script configured for ${String(repo.path)} — nothing was validated before implement`,
    cause: 'configure one via `project` settings to gate the working tree',
    at: deps.clock(),
  });
  return next;
};

/**
 * Spawns the configured setup command. Cancellation propagates verbatim: a
 * `Result.error(AbortError)` from the runner is a user-initiated abort, not a setup failure —
 * returned untouched so the chain tears down per "AbortError is the one error chains
 * propagate transparently" — never folded into a `spawn-error` row or a failed-gate banner.
 *
 * A genuine spawn-time failure (the shell could not start the command at all — ENOENT, etc)
 * is recorded here with `exitCode: -1` so consumers can distinguish "ran and failed" from
 * "could not run" without parsing the message string, and returns the `InvalidStateError` for
 * the caller to propagate.
 */
const runSetupSpawn = async (
  repo: SetupRepoEntry,
  command: string,
  opts: SetupScriptRunnerLeafOpts,
  execution: SprintExecution,
  deps: SetupScriptRunnerLeafDeps,
  signal?: AbortSignal
): Promise<Result<ShellScriptResult, DomainError>> => {
  const spawnResult = await deps.shellScriptRunner.run(repo.path, command, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    env: { RALPHCTL_LIFECYCLE_EVENT: 'setup' },
    // Thread the chain abort signal so a Ctrl-C mid-setup kills the child promptly
    // instead of waiting out the timeout while the repo lock is held. A cancel surfaces
    // as `AbortError` below (propagated verbatim — never folded into a spawn-error row).
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!spawnResult.ok && spawnResult.error.code === ErrorCode.Aborted) {
    return Result.error(spawnResult.error);
  }

  if (!spawnResult.ok) {
    // The spawn error message is surfaced on the abort log + banner cause (no longer
    // persisted on the row).
    const run: SetupRun = {
      repositoryId: repo.repositoryId,
      ranAt: deps.clock(),
      command,
      exitCode: -1,
      durationMs: 0,
      outcome: 'spawn-error',
    };
    await persistRun(execution, run, deps);
    deps.eventBus.publish({
      type: 'log',
      level: 'error',
      message: `setup-script ${String(repo.path)}: spawn-error — ${spawnResult.error.message}`,
      at: deps.clock(),
    });
    deps.eventBus.publish({
      type: BANNER_SHOW,
      id: `setup-script-${String(repo.repositoryId)}`,
      tier: 'error',
      message: `Setup script failed for ${String(repo.path)}: ${command}`,
      cause: `spawn-error — ${spawnResult.error.message}`,
      at: deps.clock(),
    });
    return Result.error(
      new InvalidStateError({
        entity: 'sprint',
        currentState: 'pre-implement',
        attemptedAction: 'setup-script',
        message: `setup-script (${basename(String(repo.path))}) could not spawn: ${spawnResult.error.message}`,
        hint: 'Ensure the setup command is on PATH and is executable from the repo root.',
      })
    );
  }

  return spawnResult;
};

/** Outcome of running (or skipping) ONE repo's setup script — folded by `executeSetupScriptRunner`. */
type RepoSetupOutcome =
  /** Nothing ran this invocation: no script configured, or a prior success still stands. */
  | { readonly kind: 'skipped'; readonly execution: SprintExecution; readonly tree?: SetupTreeRecord | undefined }
  /**
   * The script ran green. `tree` is the check's answer (absent when no guard is wired). Only a run
   * whose tree stayed `'unchanged'` (or that had no check) verified the tree the first task sees —
   * see {@link LeafOutput.verifiedThisRun}.
   */
  | {
      readonly kind: 'ran';
      readonly execution: SprintExecution;
      readonly repositoryId: RepositoryId;
      readonly tree: SetupTreeRecord | undefined;
    }
  | { readonly kind: 'failed'; readonly error: DomainError };

/**
 * Runs (or skips) ONE repo's configured setup script per the resume / no-script / spawn gates
 * documented above the leaf, folding the result into a single {@link RepoSetupOutcome}. Split out
 * of `executeSetupScriptRunner` so the per-repo branch count (already-run guard, script-missing
 * guard, spawn + audit + failure classification) doesn't accumulate onto that function's own
 * cognitive-complexity budget — the loop body becomes one call plus a small fold.
 */
const runRepoSetup = async (
  repo: SetupRepoEntry,
  execution: SprintExecution,
  opts: SetupScriptRunnerLeafOpts,
  deps: SetupScriptRunnerLeafDeps,
  signal?: AbortSignal
): Promise<RepoSetupOutcome> => {
  const command = repo.setupScript?.trim() ?? '';
  // Script-missing guard: nothing configured to validate for this repo.
  if (command.length === 0) {
    return { kind: 'skipped', execution: await runNoScriptSkip(execution, repo, deps) };
  }
  // Already-run guard: a prior chain on this sprint already validated this repo's command.
  const resumed = resumableSuccess(execution, repo, command, deps);
  if (resumed !== undefined) return { kind: 'skipped', execution, tree: resumed.tree };

  // Snapshot the tree right before the spawn so the post-setup check attributes exactly what this
  // script changed — nothing else runs in between.
  const treeCheck = deps.treeGuard === undefined ? undefined : await deps.treeGuard(repo.path);
  if (treeCheck !== undefined && !treeCheck.ok) return { kind: 'failed', error: treeCheck.error };

  const startedAt = deps.clock();
  const spawnResult = await runSetupSpawn(repo, command, opts, execution, deps, signal);
  if (!spawnResult.ok) {
    return { kind: 'failed', error: spawnResult.error };
  }

  const { passed, exitCode, output, durationMs } = spawnResult.value;
  await persistSetupLog(deps, opts.sprintDir, repo, output);
  const row: SpawnedRunRow = {
    repositoryId: repo.repositoryId,
    ranAt: startedAt,
    command,
    exitCode: exitCode ?? -1,
    durationMs,
  };

  // Failure classification: a spawned-but-red script fails the leaf; a green one verifies the repo.
  if (!passed) {
    await persistRun(execution, { ...row, outcome: 'failed' }, deps);
    return { kind: 'failed', error: buildSetupFailureError(repo, command, exitCode, output, deps) };
  }
  return recordGreenRun(repo, execution, row, treeCheck?.value, deps);
};

/** The audit fields of a run that spawned — its outcome (and tree answer) are added on write. */
type SpawnedRunRow = Omit<SetupRun, 'outcome' | 'tree'>;

/**
 * A green run: settle its working-tree check, then write ONE success row carrying the answer. A
 * check that failed (git error, Cancel, dismissed menu, policy `cancel`) leaves the row without
 * one — so the next launch runs setup again instead of resume-skipping it — and fails the leaf.
 */
const recordGreenRun = async (
  repo: SetupRepoEntry,
  execution: SprintExecution,
  row: SpawnedRunRow,
  check: SetupTreeCheck | undefined,
  deps: SetupScriptRunnerLeafDeps
): Promise<RepoSetupOutcome> => {
  deps.eventBus.publish({
    type: 'log',
    level: 'info',
    message: `setup-script ${String(repo.path)}: success (exit=0, ${String(row.durationMs)}ms)`,
    at: deps.clock(),
  });
  const settled = check === undefined ? undefined : await check({ command: row.command });
  const tree = settled?.ok === true ? settled.value : undefined;
  const nextExecution = await persistRun(
    execution,
    { ...row, outcome: 'success', ...(tree !== undefined ? { tree } : {}) },
    deps
  );
  if (settled !== undefined && !settled.ok) return { kind: 'failed', error: settled.error };
  return { kind: 'ran', execution: nextExecution, repositoryId: repo.repositoryId, tree };
};

/**
 * Iterates every repo, running (or skipping) its configured setup script via {@link runRepoSetup}.
 * See `setupScriptRunnerLeaf` for the full outcome/audit contract.
 */
const executeSetupScriptRunner = async (
  deps: SetupScriptRunnerLeafDeps,
  opts: SetupScriptRunnerLeafOpts,
  input: LeafInput,
  signal?: AbortSignal
): Promise<Result<LeafOutput, DomainError>> => {
  let execution = input.execution;
  // Repos whose setup ran green in THIS invocation. Seeds the
  // `skipPreVerifyOnFreshSetup` fast path on the first pre-task-verify. The resume-skip
  // and no-script paths deliberately do NOT contribute — only a fresh green run proves
  // the tree was verified by this launch — and neither does a run that changed the tree.
  const verifiedThisRun: RepositoryId[] = [];
  const treeRecords = new Map<RepositoryId, SetupTreeRecord>();
  for (const repo of opts.repos) {
    const outcome = await runRepoSetup(repo, execution, opts, deps, signal);
    if (outcome.kind === 'failed') return Result.error(outcome.error);
    execution = outcome.execution;
    if (outcome.tree !== undefined) treeRecords.set(repo.repositoryId, outcome.tree);
    const leftTreeAlone = outcome.tree === undefined || outcome.tree.outcome === 'unchanged';
    if (outcome.kind === 'ran' && leftTreeAlone) verifiedThisRun.push(outcome.repositoryId);
  }
  return Result.ok({ execution, verifiedThisRun, treeRecords });
};

export const setupScriptRunnerLeaf = (
  deps: SetupScriptRunnerLeafDeps,
  opts: SetupScriptRunnerLeafOpts
): Element<ImplementCtx> => {
  // Friendly rail label. Single-repo runs render as `setup-script · <repo>`; multi-repo runs
  // keep it generic (`setup-script`) so the row doesn't lie about which repo is in flight —
  // per-row attribution lives in the chain log and the BaselineHealthCard.
  const repoLabel =
    opts.repos.length === 1 && opts.repos[0] !== undefined ? ` · ${basename(String(opts.repos[0].path))}` : '';
  return leaf<ImplementCtx, LeafInput, LeafOutput>(
    'setup-script-runner',
    {
      useCase: {
        execute: (input, signal) => executeSetupScriptRunner(deps, opts, input, signal),
      },
      input: (ctx) => {
        if (ctx.execution === undefined) {
          throw new InvalidStateError({
            entity: 'chain',
            currentState: 'pre-setup-script',
            attemptedAction: 'setup-script-runner',
            message: 'setup-script-runner: ctx.execution is undefined — load-sprint-execution must run first',
          });
        }
        return { execution: ctx.execution };
      },
      // Re-stamp ctx with the (possibly mutated) execution so downstream leaves like
      // `resolveBranchLeaf` see the audit-appended value, plus the run-scoped set of repos this
      // launch's setup verified — read by the first pre-task-verify under `skipPreVerifyOnFreshSetup`
      // — and the per-repo working-tree answers the parallel task worktrees read.
      output: (ctx, out) => ({
        ...ctx,
        execution: out.execution,
        ...(out.verifiedThisRun.length > 0 ? { setupVerifiedRepoIdsThisRun: out.verifiedThisRun } : {}),
        ...(out.treeRecords.size > 0 ? { setupTreeRecords: out.treeRecords } : {}),
      }),
    },
    { label: `setup-script${repoLabel}` }
  );
};

/**
 * Append the row and persist. A persistence failure is logged but never aborts the chain —
 * the script outcome (which is what we actually wanted to verify) has already happened, and
 * losing the audit stamp at most causes a duplicate row on the next resume.
 */
const persistRun = async (
  execution: SprintExecution,
  run: SetupRun,
  deps: SetupScriptRunnerLeafDeps
): Promise<SprintExecution> => {
  const next = appendExecutionSetupRun(execution, run);
  const saved = await deps.sprintExecutionRepo.save(next);
  if (!saved.ok) {
    deps.eventBus.publish({
      type: 'log',
      level: 'warn',
      message: `setup-script audit persist failed for repo ${String(run.repositoryId)} — ${saved.error.message}`,
      at: deps.clock(),
    });
  }
  return next;
};
