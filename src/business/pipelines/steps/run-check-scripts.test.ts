import { describe, expect, it, vi } from 'vitest';
import { StepError, StorageError } from '@src/domain/errors.ts';
import type { Project, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { CheckScriptResult, ExternalPort } from '@src/business/ports/external.ts';
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
    status: 'draft',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [{ id: 't1', title: 'T1', projectName: 'p1', requirementStatus: 'approved' }],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeTask(projectPath: string, id = 'task1', status: Task['status'] = 'todo'): Task {
  return {
    id,
    name: id,
    steps: [],
    verificationCriteria: [],
    status,
    order: 1,
    blockedBy: [],
    projectPath,
    verified: false,
    evaluated: false,
  };
}

function makeProject(path: string, script?: string): Project {
  return {
    name: 'p1',
    displayName: 'P1',
    repositories: [{ name: 'r', path, checkScript: script }],
  };
}

function makeExternal(result: CheckScriptResult): ExternalPort {
  const stub = {
    runCheckScript: vi.fn(() => result),
  } as unknown as ExternalPort;
  return stub;
}

function makePersistence(
  project: Project | null,
  saveSprint: PersistencePort['saveSprint'] = () => Promise.resolve()
): PersistencePort {
  return {
    getProject: () => (project === null ? Promise.reject(new Error('not found')) : Promise.resolve(project)),
    saveSprint,
  } as unknown as PersistencePort;
}

describe('runCheckScriptsStep — sprint-start mode', () => {
  it('runs check for unique project paths', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('/a'), makeTask('/a', 'task2'), makeTask('/b', 'task3')];
    const project = makeProject('/a', 'echo ok');
    const project2 = makeProject('/b', 'echo ok2');
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;

    const persistence = {
      getProject: (name: string) =>
        name === 'p1'
          ? Promise.resolve({
              ...project,
              repositories: [...project.repositories, ...project2.repositories],
            })
          : Promise.reject(new Error('x')),
      saveSprint: vi.fn(() => Promise.resolve()),
    } as unknown as PersistencePort;

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it('skips paths already in checkRanAt unless refreshCheck is set', async () => {
    const sprint = makeSprint({ checkRanAt: { '/a': '2020-01-01' } });
    const tasks = [makeTask('/a')];
    const project = makeProject('/a', 'pnpm check');
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    // Without refresh — should skip
    let step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    let result = await step.execute({ sprintId: sprint.id, sprint, tasks });
    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();

    // With refresh — should run
    step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start', { refreshCheck: true });
    result = await step.execute({ sprintId: sprint.id, sprint, tasks });
    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it('records timestamp and saves sprint on success', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('/a')];
    const project = makeProject('/a', 'pnpm check');
    const saveSprint = vi.fn(() => Promise.resolve());
    const external = makeExternal({ passed: true, output: 'ok' });
    const persistence = makePersistence(project, saveSprint);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(saveSprint).toHaveBeenCalledTimes(1);
    expect(sprint.checkRanAt['/a']).toBeDefined();
    expect(result.value?.checkResults?.['/a']?.success).toBe(true);
  });

  it('returns StorageError when a check fails', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('/a')];
    const project = makeProject('/a', 'pnpm check');
    const external = makeExternal({ passed: false, output: 'linting failed' });
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error?.message).toContain('linting failed');
  });

  it('silently skips paths with no check script configured', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('/a')];
    const project = makeProject('/a'); // no script
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('ignores done tasks when collecting unique paths', async () => {
    const sprint = makeSprint();
    const tasks = [makeTask('/a', 'done-task', 'done'), makeTask('/b')];
    const project = makeProject('/b', 'pnpm check');
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    await step.execute({ sprintId: sprint.id, sprint, tasks });

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck).toHaveBeenCalledWith('/b', 'pnpm check', 'sprintStart', undefined);
  });

  it('returns StepError when ctx.sprint is missing', async () => {
    const external = makeExternal({ passed: true, output: '' });
    const persistence = makePersistence(null);
    const step = runCheckScriptsStep<Ctx>(external, persistence, 'sprint-start');
    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });
});

describe('runCheckScriptsStep — post-task mode', () => {
  it('runs check for the target path', async () => {
    const sprint = makeSprint();
    const project = makeProject('/a', 'pnpm check');
    const runCheck = vi.fn(() => ({ passed: true, output: 'ok' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetPath: '/a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(true);
    expect(runCheck).toHaveBeenCalledWith('/a', 'pnpm check', 'taskComplete', undefined);
    expect(result.value?.checkResults?.['/a']?.success).toBe(true);
  });

  it('returns StorageError when post-task check fails', async () => {
    const sprint = makeSprint();
    const project = makeProject('/a', 'pnpm check');
    const external = makeExternal({ passed: false, output: 'test failure' });
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetPath: '/a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
  });

  it('returns StepError when targetPath is missing', async () => {
    const external = makeExternal({ passed: true, output: '' });
    const persistence = makePersistence(null);
    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task');
    const result = await step.execute({ sprintId: 's1', sprint: makeSprint() });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StepError);
  });

  it('treats missing check script as pass (no side effects)', async () => {
    const sprint = makeSprint();
    const project = makeProject('/a'); // no script
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetPath: '/a' });
    const result = await step.execute({ sprintId: sprint.id, sprint });

    expect(result.ok).toBe(true);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('passes per-repo checkTimeout when configured', async () => {
    const sprint = makeSprint();
    const project: Project = {
      name: 'p1',
      displayName: 'P1',
      repositories: [{ name: 'r', path: '/a', checkScript: 'pnpm check', checkTimeout: 9999 }],
    };
    const runCheck = vi.fn(() => ({ passed: true, output: '' }));
    const external = { runCheckScript: runCheck } as unknown as ExternalPort;
    const persistence = makePersistence(project);

    const step = runCheckScriptsStep<Ctx>(external, persistence, 'post-task', { targetPath: '/a' });
    await step.execute({ sprintId: sprint.id, sprint });

    expect(runCheck).toHaveBeenCalledWith('/a', 'pnpm check', 'taskComplete', 9999);
  });
});
