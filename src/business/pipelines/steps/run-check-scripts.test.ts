import { describe, expect, it, vi } from 'vitest';
import { StepError, StorageError } from '@src/domain/errors.ts';
import type { Project, Repository, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { CheckResult, StepContext } from '@src/domain/context.ts';
import { runCheckScriptsStep } from './run-check-scripts.ts';

interface Ctx extends StepContext {
  sprint?: Sprint;
  tasks?: Task[];
  checkResults?: Record<string, CheckResult>;
}

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    name: 'Sprint 1',
    projectId: 'proj-1',
    status: 'draft',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [{ id: 't1', title: 'T1', requirementStatus: 'approved' }],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeTask(repoId: string, id = 'task1', status: Task['status'] = 'todo'): Task {
  return {
    id,
    name: id,
    steps: [],
    verificationCriteria: [],
    status,
    order: 1,
    blockedBy: [],
    repoId,
    verified: false,
    evaluated: false,
  };
}

function makeRepo(id: string, path: string, checkScript?: string, checkTimeout?: number): Repository {
  return { id, name: `repo-${id}`, path, checkScript, checkTimeout };
}

function makeProject(repositories: Repository[]): Project {
  return {
    id: 'proj-1',
    name: 'p1',
    displayName: 'P1',
    repositories,
  };
}

function makePersistence(
  project: Project | null,
  saveSprint: PersistencePort['saveSprint'] = () => Promise.resolve()
): PersistencePort {
  const getRepoById = (repoId: string) => {
    if (!project) return Promise.reject(new Error('not found'));
    const repo = project.repositories.find((r) => r.id === repoId);
    if (!repo) return Promise.reject(new Error('not found'));
    return Promise.resolve({ project, repo });
  };
  return {
    getRepoById,
    saveSprint,
  } as unknown as PersistencePort;
}

describe('runCheckScriptsStep — sprint-start mode', () => {
  it('runs check for unique repo ids', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('r-a'), makeTask('r-a', 'task2'), makeTask('r-b', 'task3')];
    const project = makeProject([makeRepo('r-a', '/a', 'echo ok'), makeRepo('r-b', '/b', 'echo ok2')]);
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(
      project,
      vi.fn(() => Promise.resolve())
    );

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it('skips repos already in checkRanAt unless refreshCheck is set', async () => {
    const sprint = makeSprint({ checkRanAt: { 'r-a': '2020-01-01' } });
    const tasks = [makeTask('r-a')];
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check')]);
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    let step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    let result = await step.execute({ sprintId: sprint.id, sprint, tasks });
    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();

    step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start', { refreshCheck: true });
    result = await step.execute({ sprintId: sprint.id, sprint, tasks });
    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it('records timestamp and saves sprint on success', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('r-a')];
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check')]);
    const saveSprint = vi.fn(() => Promise.resolve());
    const external = { runCheckScript: vi.fn(() => ({ passed: true, output: 'ok' })) } as unknown as ExternalPort;
    const persistence = makePersistence(project, saveSprint);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(saveSprint).toHaveBeenCalledTimes(1);
    expect(sprint.checkRanAt['r-a']).toBeDefined();
    expect(result.value?.checkResults?.['r-a']?.success).toBe(true);
  });

  it('returns StorageError when a check fails', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('r-a')];
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check')]);
    const external = {
      runCheckScript: vi.fn(() => ({ passed: false, output: 'linting failed' })),
    } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error?.message).toContain('linting failed');
  });

  it('silently skips repos with no check script configured', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('r-a')];
    const project = makeProject([makeRepo('r-a', '/a')]); // no script
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('ignores done tasks when collecting unique repo ids', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('r-a', 'done-task', 'done'), makeTask('r-b')];
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check'), makeRepo('r-b', '/b', 'pnpm check')]);
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck).toHaveBeenCalledWith('/b', 'pnpm check', 'sprintStart', undefined);
  });

  it('returns StepError when ctx.sprint is missing', async () => {
    const external = { runCheckScript: vi.fn() } as unknown as ExternalPort;
    const persistence = makePersistence(null);
    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });
});

describe('runCheckScriptsStep — post-task mode', () => {
  it('runs check for the target repo', async () => {
    const sprint = makeSprint();
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check')]);
    const runCheck = vi.fn(() => ({ passed: true, output: 'ok' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetRepoId: 'r-a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledWith('/a', 'pnpm check', 'taskComplete', undefined);
    expect(result.value?.checkResults?.['r-a']?.success).toBe(true);
  });

  it('returns StorageError when post-task check fails', async () => {
    const sprint = makeSprint();
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check')]);
    const external = {
      runCheckScript: vi.fn(() => ({ passed: false, output: 'test failure' })),
    } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetRepoId: 'r-a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
  });

  it('returns StepError when targetRepoId is missing', async () => {
    const external = { runCheckScript: vi.fn() } as unknown as ExternalPort;
    const persistence = makePersistence(null);
    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint() });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });

  it('treats missing check script as pass (no side effects)', async () => {
    const sprint = makeSprint();
    const project = makeProject([makeRepo('r-a', '/a')]); // no script
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetRepoId: 'r-a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('passes per-repo checkTimeout when configured', async () => {
    const sprint = makeSprint();
    const project = makeProject([makeRepo('r-a', '/a', 'pnpm check', 9999)]);
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetRepoId: 'r-a' });
    await step.execute({ sprintId: sprint.id, sprint });

    expect(runCheck).toHaveBeenCalledWith('/a', 'pnpm check', 'taskComplete', 9999);
  });
});
