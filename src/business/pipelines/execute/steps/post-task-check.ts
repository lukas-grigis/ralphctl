import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Run the post-task check gate (lint/typecheck/test per-repo). If the
 * check fails the step returns `ParseError` — the scheduler's retry policy
 * in commit 3 maps this to `skip-repo` so sibling repos keep progressing
 * while the failing repo is paused.
 *
 * No-op (passes) when the project has no `checkScript` configured.
 */
export function postTaskCheck(deps: { useCase: ExecuteTasksUseCase }): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('post-task-check', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;
    const passed = await deps.useCase.runPostTaskCheck(task, sprint);

    if (!passed) {
      return Result.error(new ParseError(`Post-task check failed: ${task.name}`));
    }

    const empty: Partial<PerTaskContext> = {};
    return Result.ok(empty) as DomainResult<Partial<PerTaskContext>>;
  });
}
