/**
 * `project repo add` — add a repository to an existing project.
 */
import type { Command } from 'commander';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { AddRepositoryToProjectUseCase } from '../../../business/usecases/project/add-repository-to-project.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { parseId, runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatProjectCard } from '../format/format-project.ts';

interface ProjectRepoAddFlags {
  readonly project: string;
  readonly path: string;
  readonly checkScript?: string;
}

export function attachProjectRepoAdd(group: Command, deps: SharedDeps): void {
  group
    .command('repo-add')
    .description('add a repository to an existing project')
    .requiredOption('--project <name>', 'project name')
    .requiredOption('--path <abs-path>', 'absolute path to the repository')
    .option('--check-script <cmd>', 'optional check script')
    .action(async (opts: ProjectRepoAddFlags) => {
      const code = await runProjectRepoAdd(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectRepoAdd(deps: SharedDeps, opts: ProjectRepoAddFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const projectName = parseId(ProjectName, opts.project);
      if (!projectName.ok) return projectName;
      const path = parseId(AbsolutePath, opts.path);
      if (!path.ok) return path;
      const useCase = new AddRepositoryToProjectUseCase(deps.projectRepo);
      return useCase.execute({
        projectName: projectName.value,
        repository: {
          path: path.value,
          ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
        },
      });
    },
    format: (_d, project) => formatProjectCard(project),
  });
}
