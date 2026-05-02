/**
 * Tests for `handleCompletionRequest`.
 *
 * The handler intercepts shell-completion env vars and routes to
 * `resolveCompletions`. Tests verify the env-detection contract — when
 * the env vars are absent we MUST return false so the caller continues
 * with the normal CLI parse path.
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { handleCompletionRequest } from './handle.ts';

function buildSprint(name = 'Sprint A'): Sprint {
  const slug = Slug.parse('sprint-a');
  if (!slug.ok) throw new Error('precondition failed');
  const projectName = ProjectName.parse('demo');
  if (!projectName.ok) throw new Error('precondition failed');
  const r = Sprint.create({
    name,
    slug: slug.value,
    now: IsoTimestamp.trustString('2026-04-29T12:00:00.000Z'),
    projectName: projectName.value,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function buildDeps(): SharedDeps {
  return {
    sprintRepo: new InMemorySprintRepository([buildSprint()]),
    projectRepo: new InMemoryProjectRepository(),
    taskRepo: new InMemoryTaskRepository(),
  } as unknown as SharedDeps;
}

function buildProgram(): Command {
  const program = new Command().name('ralphctl').description('Test').version('0.0.0');
  program.command('config').description('config');
  program.command('sprint').description('sprint');
  return program;
}

describe('handleCompletionRequest', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['COMP_CWORD'];
    delete process.env['COMP_POINT'];
    delete process.env['COMP_LINE'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns false when COMP_* env vars are absent', async () => {
    const handled = await handleCompletionRequest(buildProgram(), buildDeps());
    expect(handled).toBe(false);
  });

  it('returns false when COMP_CWORD is missing', async () => {
    process.env['COMP_POINT'] = '5';
    process.env['COMP_LINE'] = 'ralphctl';
    const handled = await handleCompletionRequest(buildProgram(), buildDeps());
    expect(handled).toBe(false);
  });

  it('returns false when COMP_POINT is missing', async () => {
    process.env['COMP_CWORD'] = '1';
    process.env['COMP_LINE'] = 'ralphctl';
    const handled = await handleCompletionRequest(buildProgram(), buildDeps());
    expect(handled).toBe(false);
  });

  it('returns true and writes candidates when COMP_* env vars are present', async () => {
    process.env['COMP_CWORD'] = '1';
    process.env['COMP_POINT'] = '9';
    process.env['COMP_LINE'] = 'ralphctl ';

    const handled = await handleCompletionRequest(buildProgram(), buildDeps());
    expect(handled).toBe(true);
  });
});
