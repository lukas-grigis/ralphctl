/**
 * `project add` — register a new project with one initial repository.
 *
 * Required flags:
 *   --name <slug>
 *   --display-name <text>
 *   --repo-path <abs path>
 * Optional:
 *   --description <text>
 *   --check-script <cmd>
 *
 * Wires {@link CreateProjectUseCase} from src/business/usecases/project.
 */
import type { Command } from 'commander';

import { Repository } from '../../../domain/entities/repository.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { CreateProjectUseCase } from '../../../business/usecases/project/create-project.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runCommand } from '../command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '../exit-codes.ts';
import { formatProjectCard } from '../format/format-project.ts';

interface ProjectAddFlags {
  readonly name?: string;
  readonly displayName?: string;
  readonly repoPath?: string;
  readonly description?: string;
  readonly checkScript?: string;
}

export function attachProjectAdd(group: Command, deps: SharedDeps): void {
  group
    .command('add')
    .description('register a new project with one initial repository')
    .requiredOption('--name <slug>', 'project name (lowercase slug)')
    .requiredOption('--display-name <text>', 'human-readable project name')
    .requiredOption('--repo-path <path>', 'absolute path to the initial repository')
    .option('--description <text>', 'optional description')
    .option('--check-script <cmd>', 'optional check script for the initial repo')
    .action(async (opts: ProjectAddFlags) => {
      const code = await runProjectAdd(deps, opts);
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export async function runProjectAdd(deps: SharedDeps, opts: ProjectAddFlags): Promise<ExitCode> {
  return runCommand({
    deps,
    body: async () => {
      const nameResult = ProjectName.parse(opts.name ?? '');
      if (!nameResult.ok) return Result.error(nameResult.error);
      const pathResult = AbsolutePath.parse(opts.repoPath ?? '');
      if (!pathResult.ok) return Result.error(pathResult.error);

      const repoResult = Repository.create({
        path: pathResult.value,
        ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
      });
      if (!repoResult.ok) return Result.error(repoResult.error);

      const useCase = new CreateProjectUseCase(deps.projectRepo);
      return useCase.execute({
        name: nameResult.value,
        displayName: opts.displayName ?? nameResult.value,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        repositories: [repoResult.value],
      });
    },
    format: (_d, project) => formatProjectCard(project),
  });
}
