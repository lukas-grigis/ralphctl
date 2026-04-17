import { join } from 'node:path';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';
import type { PerTaskContext } from '../per-task-context.ts';
import { buildContractMarkdown } from '../contract-content.ts';
import { findProjectForRepoId, resolveCheckScriptForRepo } from '@src/business/pipelines/steps/project-lookup.ts';

/**
 * Write the per-task sprint contract and stash its path on the context.
 *
 * Placement: between `branch-preflight` and `mark-in-progress` in the
 * per-task pipeline. We write the contract once the branch is verified
 * (no point writing it if the task will be requeued) but before the
 * generator actually starts (so the file exists when the agent reads it).
 *
 * File: `<sprintDir>/contracts/<taskId>.md`. The directory is
 * `--add-dir`'d when the generator / evaluator spawn, so both have read
 * access to the contract via a stable path.
 *
 * Failures bubble as `StorageError` — this is deterministic I/O (filesystem
 * must work for the harness to function at all), so there's no graceful
 * degradation path.
 */
export function contractNegotiate(deps: {
  persistence: PersistencePort;
  fs: FilesystemPort;
}): PipelineStep<PerTaskContext> {
  return step<PerTaskContext>('contract-negotiate', async (ctx): Promise<DomainResult<Partial<PerTaskContext>>> => {
    const { task, sprint } = ctx;

    try {
      const resolved = await findProjectForRepoId(deps.persistence, task.repoId);
      const checkScript = resolveCheckScriptForRepo(resolved?.repo);
      const repoPath = resolved?.repo.path ?? (await deps.persistence.resolveRepoPath(task.repoId));

      const markdown = buildContractMarkdown({ task, repoPath, checkScript });

      const sprintDir = deps.fs.getSprintDir(sprint.id);
      const contractsDir = join(sprintDir, 'contracts');
      await deps.fs.ensureDir(contractsDir);

      const contractPath = join(contractsDir, `${task.id}.md`);
      await deps.fs.writeFile(contractPath, markdown);

      const partial: Partial<PerTaskContext> = { contractPath };
      return Result.ok(partial) as DomainResult<Partial<PerTaskContext>>;
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to write sprint contract for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  });
}
