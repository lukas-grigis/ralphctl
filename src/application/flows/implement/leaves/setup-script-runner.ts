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

/** Harness-side setup-script gate. */

export interface SetupScriptRunnerLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly sprintExecutionRepo: Save<SprintExecution>;
  readonly logger: Logger;
  /** Atomic whole-file writer for the persisted setup log — see `persistSetupLog`. Optional. */
  readonly writeFile?: WriteFile;
  /** Post-setup working-tree check — see {@link SetupTreeGuard}. */
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
   * Per-sprint state directory. When set, the leaf writes the full untruncated setup-script output to
   * `<sprintDir>/logs/setup/<repo-id>.log` per audit [01] / [03].
   */
  readonly sprintDir?: AbsolutePath;
}

interface LeafInput {
  readonly execution: SprintExecution;
}

interface LeafOutput {
  readonly execution: SprintExecution;
  /** Repository ids whose setup script ran green DURING THIS invocation. */
  readonly verifiedThisRun: readonly RepositoryId[];
  /**
   * Per repo, the post-setup working-tree answer — recorded by this invocation's check or carried from the
   * resume-skipped row. Lifted onto `ctx.setupTreeRecords`.
   */
  readonly treeRecords: ReadonlyMap<RepositoryId, SetupTreeRecord>;
}

/**
 * Resume gate: the success row a prior chain on this sprint left for this repo, when it still stands for the current
 * command (and, with a tree guard wired, carries the full working-tree answer). `undefined` means the script must run.
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

/** No script configured is NOT a failure — the chain continues. */
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
    message: `No setup script for ${basename(String(repo.path))} — nothing validated`,
    cause: '· set one in project settings',
    at: deps.clock(),
  });
  return next;
};

/** Spawns the configured setup command. */
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
    // Thread the chain abort signal so a Ctrl-C mid-setup kills the child promptly instead of waiting out the timeout
    // while the repo lock is held.
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!spawnResult.ok && spawnResult.error.code === ErrorCode.Aborted) {
    return Result.error(spawnResult.error);
  }

  if (!spawnResult.ok) {
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
  /** The script ran green. `tree` is the check's answer (absent when no guard is wired). */
  | {
      readonly kind: 'ran';
      readonly execution: SprintExecution;
      readonly repositoryId: RepositoryId;
      readonly tree: SetupTreeRecord | undefined;
    }
  | { readonly kind: 'failed'; readonly error: DomainError };

/**
 * Runs (or skips) ONE repo's configured setup script per the resume / no-script / spawn gates documented above the
 * leaf, folding the result into a single {@link RepoSetupOutcome}.
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

/** A green run: settle its working-tree check, then write ONE success row carrying the answer. */
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
 * Iterates every repo, running (or skipping) its configured setup script via {@link runRepoSetup}. See
 * `setupScriptRunnerLeaf` for the full outcome/audit contract.
 */
const executeSetupScriptRunner = async (
  deps: SetupScriptRunnerLeafDeps,
  opts: SetupScriptRunnerLeafOpts,
  input: LeafInput,
  signal?: AbortSignal
): Promise<Result<LeafOutput, DomainError>> => {
  let execution = input.execution;
  // Repos whose setup ran green in THIS invocation. Seeds the `skipPreVerifyOnFreshSetup` fast path on the first
  // pre-task-verify.
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
  // Friendly rail label.
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
      // Re-stamp ctx with the (possibly mutated) execution so downstream leaves like `resolveBranchLeaf` see the
      // audit-appended value.
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

/** Append the row and persist. */
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
