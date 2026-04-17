import type { CheckResult, StepContext } from '@src/domain/context.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StepError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import { findProjectForRepoId, resolveCheckScriptForRepo } from './project-lookup.ts';

export type CheckScriptsMode = 'sprint-start' | 'post-task';

export interface RunCheckScriptsOptions {
  /** Force re-running a check even if `sprint.checkRanAt` already has a
   *  timestamp for the repo. Only meaningful in `'sprint-start'` mode. */
  refreshCheck?: boolean;
  /** In `'post-task'` mode, the single repoId to run the check for.
   *  Ignored in `'sprint-start'` mode (repoIds are derived from tasks). */
  targetRepoId?: string;
}

/**
 * Run configured check scripts for the sprint.
 *
 * `mode === 'sprint-start'`:
 *   - Iterates unique `repoId` values from non-done tasks
 *   - Skips repos already recorded in `sprint.checkRanAt` unless `refreshCheck`
 *   - Records a timestamp (keyed by repoId) + persists sprint after each run
 *   - Aborts with `StorageError` on the first failure
 *
 * `mode === 'post-task'`:
 *   - Runs the check for the single `options.targetRepoId` (required)
 *   - Does NOT update `sprint.checkRanAt` (post-task is transient)
 *   - Returns failure via `ctx.checkResults` — caller decides flow
 *
 * In both modes, `ctx.checkResults` is populated with a `CheckResult` per
 * repoId so downstream steps can inspect outputs/timestamps.
 */
export function runCheckScriptsStep<
  TCtx extends StepContext & { sprint?: Sprint; tasks?: Task[]; checkResults?: Record<string, CheckResult> },
>(
  external: ExternalPort,
  persistence: PersistencePort,
  mode: CheckScriptsMode,
  options?: RunCheckScriptsOptions
): PipelineStep<TCtx> {
  return step<TCtx>('run-check-scripts', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    const sprint = ctx.sprint;
    if (!sprint) {
      return Result.error(
        new StepError('run-check-scripts requires ctx.sprint — call loadSprintStep first', 'run-check-scripts')
      );
    }

    try {
      const checkResults: Record<string, CheckResult> = { ...(ctx.checkResults ?? {}) };

      if (mode === 'sprint-start') {
        const tasks = ctx.tasks ?? (await persistence.getTasks(sprint.id));
        const uniqueRepoIds = collectRepoIds(tasks);

        for (const repoId of uniqueRepoIds) {
          const previousRun = sprint.checkRanAt[repoId];
          if (previousRun && !options?.refreshCheck) continue;

          const resolved = await findProjectForRepoId(persistence, repoId);
          const checkScript = resolveCheckScriptForRepo(resolved?.repo);
          if (!resolved || !checkScript) continue;

          const { repo } = resolved;
          const result = external.runCheckScript(repo.path, checkScript, 'sprintStart', repo.checkTimeout);

          if (!result.passed) {
            checkResults[repoId] = {
              projectPath: repo.path,
              success: false,
              output: result.output,
            };
            return Result.error(new StorageError(`Check failed for ${repo.path}: ${checkScript}\n${result.output}`));
          }

          const ranAt = new Date().toISOString();
          sprint.checkRanAt[repoId] = ranAt;
          await persistence.saveSprint(sprint);

          checkResults[repoId] = {
            projectPath: repo.path,
            success: true,
            output: result.output,
            ranAt,
          };
        }
      } else {
        // post-task mode
        const targetRepoId = options?.targetRepoId;
        if (!targetRepoId) {
          return Result.error(
            new StepError('run-check-scripts in post-task mode requires options.targetRepoId', 'run-check-scripts')
          );
        }

        const resolved = await findProjectForRepoId(persistence, targetRepoId);
        const checkScript = resolveCheckScriptForRepo(resolved?.repo);
        if (!resolved || !checkScript) {
          const partial: Partial<TCtx> = { checkResults } as Partial<TCtx>;
          return Result.ok(partial) as DomainResult<Partial<TCtx>>;
        }

        const { repo } = resolved;
        const result = external.runCheckScript(repo.path, checkScript, 'taskComplete', repo.checkTimeout);

        checkResults[targetRepoId] = {
          projectPath: repo.path,
          success: result.passed,
          output: result.output,
        };

        if (!result.passed) {
          return Result.error(
            new StorageError(`Post-task check failed for ${repo.path}: ${checkScript}\n${result.output}`)
          );
        }
      }

      const partial: Partial<TCtx> = { checkResults } as Partial<TCtx>;
      return Result.ok(partial) as DomainResult<Partial<TCtx>>;
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Check script execution failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectRepoIds(tasks: Task[]): string[] {
  const remaining = tasks.filter((t) => t.status !== 'done');
  return [...new Set(remaining.map((t) => t.repoId))];
}
