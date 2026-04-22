import type { StepContext } from '@src/domain/context.ts';
import type { Sprint } from '@src/domain/models.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { StepError, StorageError } from '@src/domain/errors.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';

/**
 * Context extension consumed by the branch pre-flight step.
 *
 * A pipeline that runs branch pre-flight per-task writes the current task's
 * `projectPath` to `ctx.currentTaskProjectPath` before this step fires. If
 * no branch is configured on the sprint (`sprint.branch` is null), the step
 * is a no-op — it matches today's executor behaviour of only verifying when
 * `sprint.branch` is set.
 */
export interface BranchPreflightContext {
  currentTaskProjectPath?: string;
}

interface BranchPreflightOptions {
  /**
   * Number of verification attempts before failing. Matches the executor's
   * `MAX_BRANCH_RETRIES = 3` default. Each failed attempt waits
   * `retryDelayMs` ms before retrying.
   */
  maxRetries?: number;
  /** Delay between retry attempts. Default: 500ms. */
  retryDelayMs?: number;
  /**
   * Override how the step resolves the target project path. Defaults to
   * reading `ctx.currentTaskProjectPath`.
   */
  resolveProjectPath?: (ctx: StepContext & BranchPreflightContext & { sprint?: Sprint }) => string | undefined;
}

/**
 * Pre-flight check: verify the target repository is on the expected
 * sprint branch before executing a task.
 *
 * Mirrors the parallel-executor retry semantics in
 * `ExecuteTasksUseCase.executeParallel` — up to `maxRetries` attempts with
 * a short delay between each, then a hard `StorageError`. Sequential mode
 * in the use case additionally attempts `createAndCheckoutBranch`; that
 * recovery belongs in a follow-up step (omitted here to keep the primitive
 * side-effect-free relative to git state).
 *
 * No-op when `sprint.branch` is null/empty (branch management disabled).
 */
export function branchPreflightStep<TCtx extends StepContext & BranchPreflightContext & { sprint?: Sprint }>(
  external: ExternalPort,
  options?: BranchPreflightOptions
): PipelineStep<TCtx> {
  const maxRetries = options?.maxRetries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 500;

  return step<TCtx>('branch-preflight', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    const sprint = ctx.sprint;
    if (!sprint) {
      return Result.error(
        new StepError('branch-preflight requires ctx.sprint — call loadSprintStep first', 'branch-preflight')
      );
    }

    const branchName = sprint.branch;
    if (!branchName) {
      // Branch management disabled — nothing to verify.
      const empty: Partial<TCtx> = {};
      return Result.ok(empty) as DomainResult<Partial<TCtx>>;
    }

    const resolve = options?.resolveProjectPath ?? ((c) => c.currentTaskProjectPath);
    const projectPath = resolve(ctx);
    if (!projectPath) {
      return Result.error(
        new StepError(
          'branch-preflight requires a project path — set ctx.currentTaskProjectPath or pass resolveProjectPath',
          'branch-preflight'
        )
      );
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (external.verifyBranch(projectPath, branchName)) {
        const empty: Partial<TCtx> = {};
        return Result.ok(empty) as DomainResult<Partial<TCtx>>;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve_) => setTimeout(resolve_, retryDelayMs));
      }
    }

    return Result.error(
      new StorageError(
        `Branch verification failed after ${String(maxRetries)} attempt(s): expected '${branchName}' in ${projectPath}`
      )
    );
  });
}
