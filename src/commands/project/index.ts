import type { Command } from 'commander';
import { projectAddCommand } from '@src/commands/project/add.ts';
import { projectListCommand } from '@src/commands/project/list.ts';
import { projectRepoAddCommand, projectRepoRemoveCommand } from '@src/commands/project/repo.ts';
import { projectShowCommand } from '@src/commands/project/show.ts';
import { projectRemoveCommand } from '@src/commands/project/remove.ts';

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Manage projects');

  project.addHelpText(
    'after',
    `
Examples:
  $ ralphctl project add --name api --display-name "API Server" --path ~/code/api
  $ ralphctl project list
  $ ralphctl project show api
  $ ralphctl project repo add api ~/code/api-v2
`
  );

  project
    .command('add')
    .description('Add/update project')
    .option('--name <name>', 'Slug (lowercase, numbers, hyphens)')
    .option('--display-name <name>', 'Human-readable name')
    .option('--path <path...>', 'Repository path (repeatable)')
    .option('--description <desc>', 'Optional description')
    .option('--setup-script <cmd>', 'Setup command')
    .option('--verify-script <cmd>', 'Verification command')
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(
      async (opts: {
        name?: string;
        displayName?: string;
        path?: string[];
        description?: string;
        setupScript?: string;
        verifyScript?: string;
        interactive?: boolean;
      }) => {
        await projectAddCommand({
          name: opts.name,
          displayName: opts.displayName,
          paths: opts.path,
          description: opts.description,
          setupScript: opts.setupScript,
          verifyScript: opts.verifyScript,
          // --no-interactive sets interactive=false, otherwise true (prompt for missing)
          interactive: opts.interactive !== false,
        });
      }
    );

  project.command('list').description('List all projects').action(projectListCommand);

  project
    .command('show [name]')
    .description('Show project details')
    .action(async (name?: string) => {
      await projectShowCommand(name ? [name] : []);
    });

  project
    .command('remove [name]')
    .description('Remove a project')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name?: string, opts?: { yes?: boolean }) => {
      const args: string[] = [];
      if (name) args.push(name);
      if (opts?.yes) args.push('-y');
      await projectRemoveCommand(args);
    });

  const repo = project.command('repo').description('Manage project repositories');

  repo.addHelpText(
    'after',
    `
Examples:
  $ ralphctl project repo add my-app ~/code/new-service
  $ ralphctl project repo remove my-app ~/code/old-service
`
  );

  repo
    .command('add [name] [path]')
    .description('Add repository to project')
    .action(async (name?: string, pathArg?: string) => {
      const args: string[] = [];
      if (name) args.push(name);
      if (pathArg) args.push(pathArg);
      await projectRepoAddCommand(args);
    });

  repo
    .command('remove [name] [path]')
    .description('Remove repository from project')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name?: string, pathArg?: string, opts?: { yes?: boolean }) => {
      const args: string[] = [];
      if (name) args.push(name);
      if (pathArg) args.push(pathArg);
      if (opts?.yes) args.push('-y');
      await projectRepoRemoveCommand(args);
    });
}
