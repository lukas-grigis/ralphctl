import type { CheckResult, StepContext } from '@src/domain/context.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StepError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import { findProjectForPath, resolveCheckScript } from './project-lookup.ts';

export type CheckScriptsMode = 'sprint-start' | 'post-task';

export interface RunCheckScriptsOptions {
  /** Force re-running a check even if `sprint.checkRanAt` already has a
   *  timestamp for the path. Only meaningful in `'sprint-start'` mode. */
  refreshCheck?: boolean;
  /** In `'post-task'` mode, the single project path to run the check for.
   *  Ignored in `'sprint-start'` mode (paths are derived from tasks). */
  targetPath?: string;
}

/**
 * Run configured check scripts for the sprint.
 *
 * `mode === 'sprint-start'`:
 *   - Iterates unique `projectPath` values from non-done tasks
 *   - Skips paths already recorded in `sprint.checkRanAt` unless `refreshCheck`
 *   - Records a timestamp + persists sprint after each successful run
 *   - Aborts with `StorageError` on the first failure
 *
 * `mode === 'post-task'`:
 *   - Runs the check for the single `options.targetPath` (required)
 *   - Does NOT update `sprint.checkRanAt` (post-task is transient)
 *   - Returns failure via `ctx.checkResults` — caller decides flow
 *
 * In both modes, `ctx.checkResults` is populated with a `CheckResult` per
 * path so downstream steps can inspect outputs/timestamps.
 *
 * This replicates the behaviour of `ExecuteTasksUseCase.runCheckScripts` and
 * `ExecuteTasksUseCase.runPostTaskCheck` — if the check script is missing
 * for a path it's silently skipped (not recorded as a result). If the project
 * can't be resolved for a path it's also silently skipped (matches today's
 * `findProjectForPath` returning undefined + `resolveCheckScript` returning null).
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
        const uniquePaths = collectProjectPaths(tasks);

        for (const projectPath of uniquePaths) {
          const previousRun = sprint.checkRanAt[projectPath];
          if (previousRun && !options?.refreshCheck) continue;

          const project = await findProjectForPath(persistence, sprint, projectPath);
          const checkScript = resolveCheckScript(project, projectPath);
          if (!checkScript) continue;

          const repo = project?.repositories.find((r) => r.path === projectPath);
          const result = external.runCheckScript(projectPath, checkScript, 'sprintStart', repo?.checkTimeout);

          if (!result.passed) {
            // Record the failure so callers can inspect it even after abort.
            checkResults[projectPath] = {
              projectPath,
              success: false,
              output: result.output,
            };
            return Result.error(new StorageError(`Check failed for ${projectPath}: ${checkScript}\n${result.output}`));
          }

          const ranAt = new Date().toISOString();
          sprint.checkRanAt[projectPath] = ranAt;
          await persistence.saveSprint(sprint);

          checkResults[projectPath] = {
            projectPath,
            success: true,
            output: result.output,
            ranAt,
          };
        }
      } else {
        // post-task mode
        const target = options?.targetPath;
        if (!target) {
          return Result.error(
            new StepError('run-check-scripts in post-task mode requires options.targetPath', 'run-check-scripts')
          );
        }

        const project = await findProjectForPath(persistence, sprint, target);
        const checkScript = resolveCheckScript(project, target);
        if (!checkScript) {
          // No check configured — treat as success, record nothing to match
          // today's behaviour (post-task gate returns `true`).
          const partial: Partial<TCtx> = { checkResults } as Partial<TCtx>;
          return Result.ok(partial) as DomainResult<Partial<TCtx>>;
        }

        const repo = project?.repositories.find((r) => r.path === target);
        const result = external.runCheckScript(target, checkScript, 'taskComplete', repo?.checkTimeout);

        checkResults[target] = {
          projectPath: target,
          success: result.passed,
          output: result.output,
        };

        if (!result.passed) {
          return Result.error(
            new StorageError(`Post-task check failed for ${target}: ${checkScript}\n${result.output}`)
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

function collectProjectPaths(tasks: Task[]): string[] {
  const remaining = tasks.filter((t) => t.status !== 'done');
  return [...new Set(remaining.map((t) => t.projectPath))];
}
