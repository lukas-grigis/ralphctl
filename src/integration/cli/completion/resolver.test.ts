import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { type CompletionContext, resolveCompletions } from './resolver.ts';

/**
 * Build a mock Commander program mirroring the real CLI structure.
 */
function buildMockProgram(): Command {
  const program = new Command();
  program.name('ralphctl');

  // sprint group
  const sprint = program.command('sprint').description('Manage sprints');
  sprint
    .command('create')
    .description('Create a new sprint')
    .option('--name <name>', 'Sprint name')
    .option('-n, --no-interactive', 'Non-interactive mode');
  sprint.command('list').description('List all sprints').option('--status <status>', 'Filter by status');
  sprint.command('show').argument('[id]', 'Sprint ID').description('Show sprint details');
  sprint
    .command('start')
    .argument('[id]', 'Sprint ID')
    .description('Run automated implementation loop')
    .option('-s, --session', 'Interactive AI session')
    .option('-t, --step', 'Step through tasks')
    .option('-c, --count <n>', 'Limit to N tasks')
    .option('--concurrency <n>', 'Max parallel tasks')
    .option('-f, --force', 'Skip precondition checks')
    .option('--refresh-check', 'Force re-run check scripts')
    .option('-b, --branch', 'Create sprint branch')
    .option('--branch-name <name>', 'Custom branch name');

  // project group
  const project = program.command('project').description('Manage projects');
  project
    .command('add')
    .description('Add/update project')
    .option('--name <name>', 'Slug')
    .option('--path <path...>', 'Repository path');
  project.command('list').description('List all projects');
  project.command('show').argument('[name]').description('Show project details');
  const repo = project.command('repo').description('Manage project repositories');
  repo.command('add').argument('[name]').argument('[path]').description('Add repository');
  repo.command('remove').argument('[name]').argument('[path]').description('Remove repository');

  // task group
  const task = program.command('task').description('Manage tasks');
  task
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'Filter by status')
    .option('--project <name>', 'Filter by project');
  task.command('show').argument('[id]').description('Show task details');

  // config group
  const config = program.command('config').description('Manage configuration');
  config.command('show').description('Show current configuration');
  config.command('set').argument('<key>').argument('<value>').description('Set a configuration value');

  // completion group
  const completion = program.command('completion').description('Manage shell tab-completion');
  completion.command('install').description('Install tab-completion');
  completion.command('uninstall').description('Remove tab-completion');

  return program;
}

function ctx(line: string, last: string, prev: string): CompletionContext {
  return { line, last, prev };
}

describe('resolveCompletions', () => {
  let program: Command;

  beforeEach(() => {
    program = buildMockProgram();
  });

  describe('top-level completions', () => {
    it('lists all command groups when input is empty', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl ', '', 'ralphctl'));
      const names = result.map((c) => c.name);
      expect(names).toContain('sprint');
      expect(names).toContain('project');
      expect(names).toContain('task');
      expect(names).toContain('config');
      expect(names).toContain('completion');
    });

    it('lists all command groups when typing partial', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sp', 'sp', 'ralphctl'));
      const names = result.map((c) => c.name);
      // Returns all top-level commands; shell does the filtering
      expect(names).toContain('sprint');
      expect(names).toContain('project');
    });
  });

  describe('subcommand completions', () => {
    it('lists sprint subcommands', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint ', '', 'sprint'));
      const names = result.map((c) => c.name);
      expect(names).toContain('create');
      expect(names).toContain('list');
      expect(names).toContain('show');
      expect(names).toContain('start');
    });

    it('lists project subcommands', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl project ', '', 'project'));
      const names = result.map((c) => c.name);
      expect(names).toContain('add');
      expect(names).toContain('list');
      expect(names).toContain('show');
      expect(names).toContain('repo');
    });

    it('lists nested project repo subcommands', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl project repo ', '', 'repo'));
      const names = result.map((c) => c.name);
      expect(names).toContain('add');
      expect(names).toContain('remove');
    });
  });

  describe('flag completions', () => {
    it('lists sprint start flags when typing --', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint start --', '--', 'start'));
      const names = result.map((c) => c.name);
      expect(names).toContain('--session');
      expect(names).toContain('--step');
      expect(names).toContain('--count');
      expect(names).toContain('--force');
      expect(names).toContain('--branch');
      expect(names).toContain('--branch-name');
    });

    it('lists sprint create flags', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint create --', '--', 'create'));
      const names = result.map((c) => c.name);
      expect(names).toContain('--name');
    });

    it('returns options when typing short flag prefix', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint start -', '-', 'start'));
      const names = result.map((c) => c.name);
      expect(names.length).toBeGreaterThan(0);
    });
  });

  describe('option value completions', () => {
    it('returns status values for --status', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint list --status ', '', '--status'));
      const names = result.map((c) => c.name);
      expect(names).toContain('draft');
      expect(names).toContain('active');
      expect(names).toContain('closed');
    });

    it('returns empty for flags that expect free-form values', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl sprint start --count ', '', '--count'));
      expect(result).toEqual([]);
    });
  });

  describe('dynamic project completions', () => {
    it('returns project names for --project', async () => {
      vi.doMock('@src/integration/persistence/project.ts', () => ({
        listProjects: vi.fn().mockResolvedValue([
          { name: 'api', displayName: 'API Server', repositories: [] },
          { name: 'web', displayName: 'Web App', repositories: [] },
        ]),
      }));

      const result = await resolveCompletions(program, ctx('ralphctl task list --project ', '', '--project'));
      const names = result.map((c) => c.name);
      expect(names).toContain('api');
      expect(names).toContain('web');

      vi.doUnmock('@src/integration/persistence/project.ts');
    });

    it('returns empty array when project store throws', async () => {
      vi.doMock('@src/integration/persistence/project.ts', () => ({
        listProjects: vi.fn().mockRejectedValue(new Error('no store')),
      }));

      const result = await resolveCompletions(program, ctx('ralphctl task list --project ', '', '--project'));
      expect(result).toEqual([]);

      vi.doUnmock('@src/integration/persistence/project.ts');
    });
  });

  describe('sprint ID completions', () => {
    it('returns sprint IDs for positional args on sprint show', async () => {
      vi.doMock('@src/integration/persistence/sprint.ts', () => ({
        listSprints: vi
          .fn()
          .mockResolvedValue([{ id: '20260101-120000-test', name: 'test', status: 'active', createdAt: '2026-01-01' }]),
      }));

      const result = await resolveCompletions(program, ctx('ralphctl sprint show ', '', 'show'));
      const names = result.map((c) => c.name);
      expect(names).toContain('20260101-120000-test');

      vi.doUnmock('@src/integration/persistence/sprint.ts');
    });
  });

  describe('config set completions', () => {
    it('returns config keys for config set', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl config set ', '', 'set'));
      const names = result.map((c) => c.name);
      expect(names).toContain('provider');
      expect(names).toContain('editor');
    });

    it('returns provider values for config set provider', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl config set provider ', '', 'provider'));
      const names = result.map((c) => c.name);
      expect(names).toContain('claude');
      expect(names).toContain('copilot');
    });

    it('returns empty for unknown config key values', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl config set editor ', '', 'editor'));
      expect(result).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('returns top-level commands for program with no subcommand match', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl nonexistent ', '', 'nonexistent'));
      // Falls through since 'nonexistent' doesn't match any subcommand
      // Should still return top-level subcommands
      const names = result.map((c) => c.name);
      expect(names).toContain('sprint');
    });

    it('handles completion command itself', async () => {
      const result = await resolveCompletions(program, ctx('ralphctl completion ', '', 'completion'));
      const names = result.map((c) => c.name);
      expect(names).toContain('install');
      expect(names).toContain('uninstall');
    });
  });
});
