/**
 * `project repo remove` — drop a repository from an existing project.
 */
import type { Command } from 'commander';

import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { RemoveRepositoryFromProjectUseCase } from '../../../business/usecases/project/remove-repository-from-project.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatProjectCard } from '../format/format-project.ts';

interface ProjectRepoRemoveFlags {
  readonly project: string;
  readonly path: string;
}

export function attachProjectRepoRemove(group: Command, deps: SharedDeps): void {
  group
    .command('repo-remove')
    .description('remove a repository from a project (project must keep one)')
    .requiredOption('--project <name>', 'project name')
    .requiredOption('--path <abs-path>', 'repository path to drop')
    .action(async (opts: ProjectRepoRemoveFlags) => {
      const code = await runProjectRepoRemove(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectRepoRemove(deps: SharedDeps, opts: ProjectRepoRemoveFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const projectName = ProjectName.parse(opts.project);
      if (!projectName.ok) return Result.error(projectName.error);
      const path = AbsolutePath.parse(opts.path);
      if (!path.ok) return Result.error(path.error);
      const useCase = new RemoveRepositoryFromProjectUseCase(deps.projectRepo);
      return useCase.execute({
        projectName: projectName.value,
        path: path.value,
      });
    },
    format: (_d, project) => formatProjectCard(project),
  });
}
