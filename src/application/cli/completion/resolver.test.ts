/**
 * Tests for the completion resolver — locks down the four core completion
 * paths the user-facing tab-completion contract relies on:
 *
 *  1. Top-level + nested subcommands
 *  2. Flag completion
 *  3. Dynamic value sources (--project, --sprint, --status, --shell)
 *  4. `config set <key> [value]` positional shape
 */
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { resolveCompletions } from './resolver.ts';

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok: ${String(r.error)}`);
  return r.value as T;
}

function buildSprint(name: string, slugStr: string): Sprint {
  return unwrap(
    Sprint.create({
      name,
      slug: unwrap(Slug.parse(slugStr)),
      now: IsoTimestamp.trustString('2026-04-29T12:00:00.000Z'),
      projectName: unwrap(ProjectName.parse('demo')),
    })
  );
}

function buildProject(name: string, displayName: string): Project {
  const repo = unwrap(
    Repository.create({
      path: AbsolutePath.trustString('/tmp/test-' + name),
    })
  );
  return unwrap(
    Project.create({
      name: unwrap(ProjectName.parse(name)),
      displayName,
      repositories: [repo],
    })
  );
}

function buildDeps(opts?: {
  readonly sprints?: readonly Sprint[];
  readonly projects?: readonly Project[];
}): SharedDeps {
  return {
    sprintRepo: new InMemorySprintRepository(opts?.sprints),
    projectRepo: new InMemoryProjectRepository(opts?.projects),
    taskRepo: new InMemoryTaskRepository(),
  } as unknown as SharedDeps;
}

function buildProgram(): Command {
  const program = new Command().name('ralphctl').description('test program').version('0.0.0');

  const config = program.command('config').description('configuration');
  config.command('show').description('show config');
  config
    .command('set')
    .description('set a config key')
    .argument('<key>', 'config key')
    .argument('[value]', 'config value');

  const sprint = program.command('sprint').description('sprint commands');
  sprint
    .command('start')
    .description('start a sprint')
    .argument('[id]', 'sprint id')
    .option('--branch', 'auto branch')
    .option('--branch-name <name>', 'custom branch name')
    .option('--no-evaluate', 'skip evaluator');
  sprint.command('show').description('show sprint').argument('[id]');
  sprint.command('list').description('list sprints').option('--status <status>', 'filter by status');

  program.command('completion').description('shell tab-completion').option('--shell <shell>', 'shell name');

  const project = program.command('project').description('project commands');
  project.command('add').description('add a project');
  project.command('list').description('list projects').option('--project <name>', 'filter by project');

  return program;
}

describe('resolveCompletions', () => {
  describe('top-level + subcommand traversal', () => {
    it('returns top-level subcommands at the root', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(program, { line: 'ralphctl ', last: '', prev: 'ralphctl' }, buildDeps());
      const names = result.map((c) => c.name);
      expect(names).toContain('config');
      expect(names).toContain('sprint');
      expect(names).toContain('completion');
      expect(names).toContain('project');
    });

    it('returns sprint subcommands after `ralphctl sprint`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl sprint ', last: '', prev: 'sprint' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('start');
      expect(names).toContain('show');
      expect(names).toContain('list');
    });

    it('returns config subcommands after `ralphctl config`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config ', last: '', prev: 'config' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('show');
      expect(names).toContain('set');
    });
  });

  describe('flag completion', () => {
    it('returns only flags when the user is typing a `-`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl sprint start -', last: '-', prev: 'start' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      // Long flag names returned as-is by Commander.
      expect(names).toContain('--branch');
      expect(names).toContain('--branch-name');
    });
  });

  describe('dynamic value sources', () => {
    it('completes --project values from the project repo', async () => {
      const program = buildProgram();
      const deps = buildDeps({ projects: [buildProject('alpha', 'Alpha'), buildProject('beta', 'Beta')] });
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl project list --project ', last: '', prev: '--project' },
        deps
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
    });

    it('completes --status values to status enums', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl sprint list --status ', last: '', prev: '--status' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('draft');
      expect(names).toContain('active');
      expect(names).toContain('closed');
      expect(names).toContain('todo');
      expect(names).toContain('done');
    });

    it('completes --shell values to bash/zsh/fish', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl completion --shell ', last: '', prev: '--shell' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toStrictEqual(['bash', 'zsh', 'fish']);
    });

    it('completes positional sprint IDs after `sprint show`', async () => {
      const program = buildProgram();
      const sprintA = buildSprint('Alpha', 'alpha');
      const sprintB = buildSprint('Beta', 'beta');
      const deps = buildDeps({ sprints: [sprintA, sprintB] });
      const result = await resolveCompletions(program, { line: 'ralphctl sprint show ', last: '', prev: 'show' }, deps);
      const names = result.map((c) => c.name);
      expect(names).toHaveLength(2);
      expect(names).toStrictEqual([String(sprintA.id), String(sprintB.id)]);
    });

    it('returns empty when --project store load fails (graceful degradation)', async () => {
      // Pass undefined repos — the in-memory fake never fails, so we simulate
      // a failure scenario by passing a deps object with a stub that errors.
      const program = buildProgram();
      const failingDeps = {
        sprintRepo: new InMemorySprintRepository(),
        projectRepo: {
          list: () => Promise.resolve({ ok: false, error: { message: 'boom' } }),
          findByName: () => Promise.resolve({ ok: false, error: { message: 'no' } }),
          save: () => Promise.resolve({ ok: true }),
          remove: () => Promise.resolve({ ok: true }),
        },
        taskRepo: new InMemoryTaskRepository(),
      } as unknown as SharedDeps;
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl project list --project ', last: '', prev: '--project' },
        failingDeps
      );
      expect(result).toStrictEqual([]);
    });
  });

  describe('config set positional shape', () => {
    it('returns config keys when typing `config set`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config set ', last: '', prev: 'set' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('aiProvider');
      expect(names).toContain('logLevel');
      expect(names).toContain('evaluationIterations');
    });

    it('returns aiProvider value choices for `config set aiProvider`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config set aiProvider ', last: '', prev: 'aiProvider' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toStrictEqual(['claude', 'copilot']);
    });

    it('returns logLevel value choices for `config set logLevel`', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config set logLevel ', last: '', prev: 'logLevel' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('debug');
      expect(names).toContain('info');
      expect(names).toContain('warn');
      expect(names).toContain('error');
    });

    it('returns empty list for unknown key', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config set unknown ', last: '', prev: 'unknown' },
        buildDeps()
      );
      expect(result).toStrictEqual([]);
    });

    it('returns config keys when user is still typing the key', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl config set aiP', last: 'aiP', prev: 'set' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('aiProvider');
    });
  });

  describe('edge cases', () => {
    it('skips flags during command tree traversal', async () => {
      const program = buildProgram();
      // The user typed a flag but we still want to land on the `start`
      // subcommand for completion.
      const result = await resolveCompletions(
        program,
        { line: 'ralphctl sprint start --branch -', last: '-', prev: '--branch' },
        buildDeps()
      );
      const names = result.map((c) => c.name);
      expect(names).toContain('--branch');
    });

    it('returns empty when after a value-bearing flag with no resolver', async () => {
      const program = buildProgram();
      const result = await resolveCompletions(
        program,
        {
          line: 'ralphctl sprint start --branch-name ',
          last: '',
          prev: '--branch-name',
        },
        buildDeps()
      );
      expect(result).toStrictEqual([]);
    });
  });
});
