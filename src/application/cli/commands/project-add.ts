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

import { Repository } from '@src/domain/entities/repository.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { CreateProjectUseCase } from '@src/business/usecases/project/create-project.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { parseId, runCommand } from '@src/application/cli/command-runner.ts';
import { EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { formatProjectCard } from '@src/application/cli/format/format-project.ts';

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
      const nameResult = parseId(ProjectName, opts.name ?? '');
      if (!nameResult.ok) return nameResult;
      const pathResult = parseId(AbsolutePath, opts.repoPath ?? '');
      if (!pathResult.ok) return pathResult;

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
