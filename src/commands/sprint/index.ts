import type { Command } from 'commander';
import { sprintCreateCommand } from '@src/commands/sprint/create.ts';
import { sprintListCommand } from '@src/commands/sprint/list.ts';
import { sprintShowCommand } from '@src/commands/sprint/show.ts';
import { sprintContextCommand } from '@src/commands/sprint/context.ts';
import { sprintCloseCommand } from '@src/commands/sprint/close.ts';
import { sprintStartCommand } from '@src/commands/sprint/start.ts';
import { sprintPlanCommand } from '@src/commands/sprint/plan.ts';
import { sprintCurrentCommand } from '@src/commands/sprint/current.ts';
import { sprintSwitchCommand } from '@src/commands/sprint/switch.ts';
import { sprintRefineCommand } from '@src/commands/sprint/refine.ts';
import { sprintIdeateCommand } from '@src/commands/sprint/ideate.ts';
import { sprintRequirementsCommand } from '@src/commands/sprint/requirements.ts';
import { sprintHealthCommand } from '@src/commands/sprint/health.ts';
import { sprintDeleteCommand } from '@src/commands/sprint/delete.ts';

export function registerSprintCommands(program: Command): void {
  const sprint = program.command('sprint').description('Manage sprints');

  sprint.addHelpText(
    'after',
    `
Examples:
  $ ralphctl sprint create --name "Sprint 1"
  $ ralphctl sprint refine              # Refine ticket requirements with AI
  $ ralphctl sprint plan --auto         # Generate tasks automatically
  $ ralphctl sprint start -s            # Start with interactive session
`
  );

  sprint
    .command('create')
    .description('Create a new sprint')
    .option('--name <name>', 'Sprint name')
    .option('-n, --no-interactive', 'Non-interactive mode (error on missing params)')
    .action(async (opts: { name?: string; interactive?: boolean }) => {
      await sprintCreateCommand({
        name: opts.name,
        // --no-interactive sets interactive=false, otherwise true (prompt for missing)
        interactive: opts.interactive !== false,
      });
    });

  sprint
    .command('list')
    .description('List all sprints')
    .option('--status <status>', 'Filter by status (draft, active, closed)')
    .action(async (opts: { status?: string }) => {
      const args: string[] = [];
      if (opts.status) args.push('--status', opts.status);
      await sprintListCommand(args);
    });

  sprint
    .command('show [id]')
    .description('Show sprint details')
    .action(async (id?: string) => {
      await sprintShowCommand(id ? [id] : []);
    });

  sprint
    .command('context [id]')
    .description('Output full context for planning')
    .action(async (id?: string) => {
      await sprintContextCommand(id ? [id] : []);
    });

  sprint
    .command('current [id]')
    .description('Show/set current sprint (use "-" to open selector)')
    .action(async (id?: string) => {
      await sprintCurrentCommand(id ? [id] : []);
    });

  sprint
    .command('switch')
    .description('Quick sprint switcher (opens selector)')
    .action(async () => {
      await sprintSwitchCommand();
    });

  sprint
    .command('refine [id]')
    .description('Refine ticket specifications')
    .option('--project <name>', 'Only refine tickets for specific project')
    .action(async (id?: string, opts?: { project?: string }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.project) args.push('--project', opts.project);
      await sprintRefineCommand(args);
    });

  sprint
    .command('ideate [id]')
    .description('Quick idea to tasks (refine + plan in one session)')
    .option('--auto', 'Run without user interaction (AI decides autonomously)')
    .option('--all-paths', 'Explore all project repositories instead of prompting for selection')
    .option('--project <name>', 'Pre-select project (skip interactive selection)')
    .action(async (id?: string, opts?: { auto?: boolean; allPaths?: boolean; project?: string }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.auto) args.push('--auto');
      if (opts?.allPaths) args.push('--all-paths');
      if (opts?.project) args.push('--project', opts.project);
      await sprintIdeateCommand(args);
    });

  sprint
    .command('plan [id]')
    .description('Generate tasks using AI CLI')
    .option('--auto', 'Run without user interaction (AI decides autonomously)')
    .option('--all-paths', 'Explore all project repositories instead of prompting for selection')
    .action(async (id?: string, opts?: { auto?: boolean; allPaths?: boolean }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.auto) args.push('--auto');
      if (opts?.allPaths) args.push('--all-paths');
      await sprintPlanCommand(args);
    });

  sprint
    .command('close [id]')
    .description('Close an active sprint')
    .action(async (id?: string) => {
      await sprintCloseCommand(id ? [id] : []);
    });

  sprint
    .command('delete [id]')
    .description('Delete a sprint permanently')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id?: string, opts?: { yes?: boolean }) => {
      const args: string[] = [];
      if (id) args.push(id);
      if (opts?.yes) args.push('-y');
      await sprintDeleteCommand(args);
    });

  sprint
    .command('requirements [id]')
    .description('Export refined requirements to file')
    .action(async (id?: string) => {
      await sprintRequirementsCommand(id ? [id] : []);
    });

  sprint
    .command('health')
    .description('Check sprint health')
    .action(async () => {
      await sprintHealthCommand();
    });

  sprint
    .command('start [id]')
    .description('Run automated implementation loop')
    .option('-s, --session', 'Interactive AI session (collaborate with your AI provider)')
    .option('-t, --step', 'Step through tasks with approval between each')
    .option('-c, --count <n>', 'Limit to N tasks')
    .option('--no-commit', 'Skip automatic git commit after each task completes')
    .option('--concurrency <n>', 'Max parallel tasks (default: auto based on unique repos)')
    .option('--max-retries <n>', 'Max rate-limit retries per task (default: 5)')
    .option('--fail-fast', 'Stop launching new tasks on first failure')
    .option('-f, --force', 'Skip precondition checks (e.g., unplanned tickets)')
    .option('--skip-setup', 'Skip running setupScript on repositories before task execution')
    .addHelpText(
      'after',
      `
Exit Codes:
  0 - Success (all requested operations completed)
  1 - Error (validation, missing params, execution failed)
  2 - No tasks available
  3 - All remaining tasks blocked by dependencies

Parallel Execution:
  Tasks targeting different repos run concurrently by default.
  At most one task per repository runs at a time to avoid git conflicts.
  Use --concurrency 1 to force sequential execution.
  Session (--session) and step (--step) modes always run sequentially.
`
    )
    .action(
      async (
        id?: string,
        opts?: {
          session?: boolean;
          step?: boolean;
          count?: string;
          commit?: boolean;
          concurrency?: string;
          maxRetries?: string;
          failFast?: boolean;
          force?: boolean;
          skipSetup?: boolean;
        }
      ) => {
        const args: string[] = [];
        if (id) args.push(id);
        if (opts?.session) args.push('--session');
        if (opts?.step) args.push('--step');
        if (opts?.count) args.push('--count', opts.count);
        if (opts?.commit === false) args.push('--no-commit');
        if (opts?.concurrency) args.push('--concurrency', opts.concurrency);
        if (opts?.maxRetries) args.push('--max-retries', opts.maxRetries);
        if (opts?.failFast) args.push('--fail-fast');
        if (opts?.force) args.push('--force');
        if (opts?.skipSetup) args.push('--skip-setup');
        await sprintStartCommand(args);
      }
    );
}
