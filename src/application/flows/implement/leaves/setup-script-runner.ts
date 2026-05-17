import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  findExecutionSetupRun,
  recordExecutionSetupRun,
  type SprintExecution,
} from '@src/domain/entity/sprint-execution.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Once-per-sprint setup script runner. Iterates every repo configured on the project and runs
 * its `setupScript` once across the sprint's lifetime. Used for environment prep that the AI
 * cannot do reliably from inside the harness session: dependency installs, codegen, native
 * build, etc.
 *
 * Per-repo state lives on `SprintExecution.setupRanAt` — an upserted audit list keyed by
 * `RepositoryId`. On re-runs the leaf skips repos that already have a stamp; only failed /
 * never-run repos are retried. Successful runs persist the new stamp through the injected
 * `sprintExecutionRepo` so a chain that aborts after a successful setup doesn't re-run that
 * repo's setup on resume.
 *
 * Failure semantics: setup is non-fatal at the leaf level. A failed setup is logged at `warn`
 * and the chain continues with the remaining repos — the AI may still make progress with
 * whatever partial environment exists, and a hard error here would block work for tasks that
 * don't depend on the failing repo's setup output.
 *
 * Repos without a `setupScript` are skipped silently; the leaf is a no-op for projects that
 * use no setup scripts at all.
 */

export interface SetupScriptRunnerLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly clock: () => IsoTimestamp;
  readonly eventBus: EventBus;
  readonly sprintExecutionRepo: Save<SprintExecution>;
  readonly logger: Logger;
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
}

interface LeafInput {
  readonly execution: SprintExecution;
}

interface LeafOutput {
  readonly execution: SprintExecution;
}

export const setupScriptRunnerLeaf = (
  deps: SetupScriptRunnerLeafDeps,
  opts: SetupScriptRunnerLeafOpts
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, LeafOutput>('setup-script-runner', {
    useCase: {
      execute: async (input) => {
        let execution = input.execution;
        for (const repo of opts.repos) {
          if (repo.setupScript === undefined || repo.setupScript.trim().length === 0) continue;
          const already = findExecutionSetupRun(execution, repo.repositoryId);
          if (already !== undefined) {
            deps.logger.named('setup-script').debug(`skip ${String(repo.path)} — already ran at ${String(already)}`);
            continue;
          }
          const result = await deps.shellScriptRunner.run(repo.path, repo.setupScript, {
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            env: { RALPHCTL_LIFECYCLE_EVENT: 'setup' },
          });
          if (!result.ok) {
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `setup-script ${String(repo.path)}: spawn failed — ${result.error.message}`,
              at: deps.clock(),
            });
            continue;
          }
          if (result.value.passed) {
            deps.eventBus.publish({
              type: 'log',
              level: 'info',
              message: `setup-script ${String(repo.path)}: passed`,
              at: deps.clock(),
            });
            execution = recordExecutionSetupRun(execution, repo.repositoryId, deps.clock());
            const saved = await deps.sprintExecutionRepo.save(execution);
            if (!saved.ok) {
              // The script ran successfully — losing the audit stamp is non-fatal. Log so the
              // user knows resume might re-run the script.
              deps.eventBus.publish({
                type: 'log',
                level: 'warn',
                message: `setup-script ${String(repo.path)}: audit stamp persist failed — ${saved.error.message}`,
                at: deps.clock(),
              });
            }
          } else {
            deps.eventBus.publish({
              type: 'log',
              level: 'warn',
              message: `setup-script ${String(repo.path)}: failed (exit=${String(result.value.exitCode ?? 'null')}) — continuing anyway`,
              at: deps.clock(),
            });
          }
        }
        return Result.ok({ execution });
      },
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
    // `resolveBranchLeaf` see the audit-stamped value.
    output: (ctx, out) => ({ ...ctx, execution: out.execution }),
  });
