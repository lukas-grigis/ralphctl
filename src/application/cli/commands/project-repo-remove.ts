/**
 * `project repo remove` — drop a repository from an existing project.
 */
import type { Command } from 'commander';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { RemoveRepositoryFromProjectUseCase } from '@src/business/usecases/project/remove-repository-from-project.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatProjectCard } from '@src/application/cli/format/format-project.ts';

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
      const projectName = parseId(ProjectName, opts.project);
      if (!projectName.ok) return projectName;
      const path = parseId(AbsolutePath, opts.path);
      if (!path.ok) return path;
      const useCase = new RemoveRepositoryFromProjectUseCase(deps.projectRepo);
      return useCase.execute({
        projectName: projectName.value,
        path: path.value,
      });
    },
    format: (_d, project) => formatProjectCard(project),
  });
}
