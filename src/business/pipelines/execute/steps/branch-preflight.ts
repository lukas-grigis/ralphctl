import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { BranchPreflightError } from '@src/domain/errors.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { step } from '@src/business/pipeline/helpers.ts';
import type { PipelineStep } from '@src/business/pipeline/types.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Verify the task's repository is on the expected sprint branch.
 *
 * Unifies on the parallel executor's semantics: verify only, no
 * `createAndCheckoutBranch` auto-recovery. The scheduler's `retryPolicy`
 * requeues the task on `BranchPreflightError` up to `MAX_BRANCH_RETRIES`
 * times before surfacing the failure. No inner retry here — retry policy
 * belongs at one layer (the scheduler), not two.
 *
 * Returns a dedicated `BranchPreflightError` (not `StorageError`) so the
 * retry policy can pattern-match by type rather than parsing error strings.
 *
 * No-op when `ctx.sprint.branch` is null.
 */
export function branchPreflight(deps: { external: ExternalPort }): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('branch-preflight', (ctx): DomainResult<Partial<PerTaskContext>> => {
    const branch = ctx.sprint.branch;
    if (!branch) {
      const empty: Partial<PerTaskContext> = {};
      return Result.ok(empty) as DomainResult<Partial<PerTaskContext>>;
    }

    if (deps.external.verifyBranch(ctx.task.projectPath, branch)) {
      const empty: Partial<PerTaskContext> = {};
      return Result.ok(empty) as DomainResult<Partial<PerTaskContext>>;
    }

    return Result.error(new BranchPreflightError(ctx.task.projectPath, branch));
  });
}
