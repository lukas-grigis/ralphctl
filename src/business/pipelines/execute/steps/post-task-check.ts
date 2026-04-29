import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import type { PerTaskContext } from '../per-task-context.ts';

/**
 * Run the post-task check gate (lint/typecheck/test per-repo). If the
 * check fails the step returns `ParseError` — the scheduler's retry policy
 * maps this to `skip-repo` so sibling repos keep progressing while the
 * failing repo is paused.
 *
 * Skipped when `mark-in-progress` captured a pre-task HEAD AND nothing has
 * changed in the repo since (no commits added, no dirty working tree).
 * That's the common case for many evaluator-driven runs where the AI did
 * its survey-only work and made no source changes — running the full
 * lint/typecheck/test suite again would be pure cost. Falls back to
 * running unconditionally when the baseline is unavailable.
 *
 * No-op (passes) when the project has no `checkScript` configured.
 */
export function postTaskCheck(deps: {
  useCase: ExecuteTasksUseCase;
  external: ExternalPort;
  persistence: PersistencePort;
  logger: LoggerPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('post-task-check', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint, preTaskHeadSha } = ctx;

    if (preTaskHeadSha) {
      const repoPath = await deps.persistence.resolveRepoPath(task.repoId).catch(() => null);
      if (repoPath) {
        const changed = deps.external.getChangedFilesSince(repoPath, preTaskHeadSha);
        if (changed.length === 0) {
          deps.logger.info(`Post-task check: skipped (no changes) — ${task.name}`);
          const empty: Partial<PerTaskContext> = {};
          return Result.ok(empty);
        }
      }
    }

    const passed = await deps.useCase.runPostTaskCheck(task, sprint);

    if (!passed) {
      return Result.error(new ParseError(`Post-task check failed: ${task.name}`));
    }

    const empty: Partial<PerTaskContext> = {};
    return Result.ok(empty);
  });
}
