/**
 * `project onboard <project>` — AI-assisted setup for a project repository.
 *
 * Drives one read-only AI inventory pass over the repo and proposes:
 *   - a project context file body (`CLAUDE.md` / `.github/copilot-instructions.md`)
 *   - a setup script (e.g. `pnpm install`)
 *   - a verify script (e.g. `pnpm typecheck && pnpm test`)
 *
 * Flags:
 *   --repo <name|path>  Pick a repo when the project has more than one.
 *   --auto              Accept the AI proposal as-is — no interactive review.
 */
import type { Command } from 'commander';

import { createOnboardFlow, type OnboardCtx } from '@src/application/chains/onboard/onboard-flow.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { printError } from '@src/application/cli/command-runner.ts';
import { EXIT_ERROR, EXIT_SUCCESS, type ExitCode } from '@src/application/cli/exit-codes.ts';
import { streamSession } from '@src/application/cli/stream-session.ts';

interface ProjectOnboardFlags {
  readonly repo?: string;
  readonly auto?: boolean;
}

export function attachProjectOnboard(group: Command, deps: SharedDeps): void {
  group
    .command('onboard <project>')
    .description('AI-assisted setup: scripts + project context file')
    .option('--repo <name|path>', 'repository name or absolute path (when project has more than one)')
    .option('--auto', 'accept AI proposals as-is without interactive review')
    .action(async (project: string, opts: ProjectOnboardFlags) => {
      const code = await runProjectOnboard(deps, { project, ...opts });
      if (code !== EXIT_SUCCESS) process.exitCode = code;
    });
}

export interface RunProjectOnboardArgs {
  readonly project: string;
  readonly repo?: string;
  readonly auto?: boolean;
}

export async function runProjectOnboard(deps: SharedDeps, args: RunProjectOnboardArgs): Promise<ExitCode> {
  const projectName = ProjectName.parse(args.project);
  if (!projectName.ok) {
    printError(deps, projectName.error);
    return EXIT_ERROR;
  }

  // Resolve --repo: accept either an absolute path or a repo name; look up
  // by name on the project when not a path.
  let repoPath: AbsolutePath | undefined;
  if (args.repo !== undefined) {
    const asPath = AbsolutePath.parse(args.repo);
    if (asPath.ok) {
      repoPath = asPath.value;
    } else {
      const projectResult = await deps.projectRepo.findByName(projectName.value);
      if (!projectResult.ok) {
        printError(deps, projectResult.error);
        return EXIT_ERROR;
      }
      const matched = projectResult.value.repositories.find((r) => r.name === args.repo);
      if (matched === undefined) {
        process.stderr.write(`error: repository '${args.repo}' not found on project '${args.project}'\n`);
        return EXIT_ERROR;
      }
      repoPath = matched.path;
    }
  }

  const autoAccept = args.auto === true;

  const flow = createOnboardFlow(deps, {
    projectName: projectName.value,
    autoAccept,
    ...(repoPath !== undefined ? { repoPath } : {}),
  });

  const initialCtx: OnboardCtx = {
    projectName: projectName.value,
    autoAccept,
    ...(repoPath !== undefined ? { repoPath } : {}),
  };

  return streamSession<OnboardCtx>({
    sessionManager: deps.sessionManager,
    label: `onboard ${args.project}`,
    element: flow,
    initialCtx,
  });
}
