import type { Command } from 'commander';
import { sprintCreateCommand } from '@src/commands/sprint/create.ts';
import { sprintListCommand } from '@src/commands/sprint/list.ts';
import { sprintShowCommand } from '@src/commands/sprint/show.ts';
import { sprintContextCommand } from '@src/commands/sprint/context.ts';
import { sprintCloseCommand } from '@src/commands/sprint/close.ts';
import { sprintStartCommand } from '@src/commands/sprint/start.ts';
import { sprintPlanCommand } from '@src/commands/sprint/plan.ts';
import { sprintCurrentCommand } from '@src/commands/sprint/current.ts';
import { sprintRefineCommand } from '@src/commands/sprint/refine.ts';

export function registerSprintCommands(program: Command): void {
  const sprint = program.command('sprint').description('Manage sprints');

  sprint.addHelpText(
    'after',
    `
Examples:
  $ ralphctl sprint create --name "Sprint 1"
  $ ralphctl sprint refine              # Refine ticket requirements with Claude
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

  sprint.command('list').description('List all sprints').action(sprintListCommand);

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
    .command('plan [id]')
    .description('Generate tasks using Claude CLI')
    .option('--auto', 'Run without user interaction (Claude decides autonomously)')
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
    .command('start [id]')
    .description('Run automated implementation loop')
    .option('-s, --session', 'Interactive Claude session (collaborate with Claude)')
    .option('-t, --step', 'Step through tasks with approval between each')
    .option('-c, --count <n>', 'Limit to N tasks')
    .option('--no-commit', 'Skip automatic git commit after each task completes')
    .option('--concurrency <n>', 'Max parallel tasks (default: auto based on unique repos)')
    .option('--max-retries <n>', 'Max rate-limit retries per task (default: 5)')
    .option('--fail-fast', 'Stop launching new tasks on first failure')
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
        await sprintStartCommand(args);
      }
    );
}
