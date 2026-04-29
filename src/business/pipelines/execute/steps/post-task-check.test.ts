import { describe, expect, it, vi } from 'vitest';
import { ParseError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { postTaskCheck } from './post-task-check.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeTask(): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: false,
    evaluated: false,
  };
}

function makeDeps(
  passed: boolean,
  changed: string[] = []
): {
  deps: {
    useCase: ExecuteTasksUseCase;
    external: ExternalPort;
    persistence: PersistencePort;
    logger: LoggerPort;
  };
  runPostTaskCheck: ReturnType<typeof vi.fn>;
  getChangedFilesSince: ReturnType<typeof vi.fn>;
} {
  const runPostTaskCheck = vi.fn(() => Promise.resolve(passed));
  const getChangedFilesSince = vi.fn(() => changed);
  return {
    deps: {
      useCase: { runPostTaskCheck } as unknown as ExecuteTasksUseCase,
      external: { getChangedFilesSince } as unknown as ExternalPort,
      persistence: { resolveRepoPath: () => Promise.resolve('/repo') } as unknown as PersistencePort,
      logger: {
        info: () => undefined,
        warning: () => undefined,
        debug: () => undefined,
        success: () => undefined,
      } as unknown as LoggerPort,
    },
    runPostTaskCheck,
    getChangedFilesSince,
  };
}

describe('postTaskCheck step', () => {
  it('passes when the check returns true', async () => {
    // Force the gate to run by leaving preTaskHeadSha undefined (no skip path).
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const { deps, runPostTaskCheck } = makeDeps(true);
    const result = await postTaskCheck(deps).execute(ctx);
    expect(result.ok).toBe(true);
    expect(runPostTaskCheck).toHaveBeenCalled();
  });

  it('returns ParseError when the check returns false', async () => {
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const { deps } = makeDeps(false);
    const result = await postTaskCheck(deps).execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('Task 1');
  });

  it('skips the check when the repo has no changes since the pre-task HEAD', async () => {
    const ctx: PerTaskContext = {
      sprintId: 's1',
      sprint: makeSprint(),
      task: makeTask(),
      preTaskHeadSha: 'abc1234',
    };
    const { deps, runPostTaskCheck, getChangedFilesSince } = makeDeps(false, []); // gate would fail if invoked
    const result = await postTaskCheck(deps).execute(ctx);
    expect(result.ok).toBe(true);
    expect(runPostTaskCheck).not.toHaveBeenCalled();
    expect(getChangedFilesSince).toHaveBeenCalledWith('/repo', 'abc1234');
  });

  it('runs the check when the repo has changes since the pre-task HEAD', async () => {
    const ctx: PerTaskContext = {
      sprintId: 's1',
      sprint: makeSprint(),
      task: makeTask(),
      preTaskHeadSha: 'abc1234',
    };
    const { deps, runPostTaskCheck } = makeDeps(true, ['src/foo.ts']);
    const result = await postTaskCheck(deps).execute(ctx);
    expect(result.ok).toBe(true);
    expect(runPostTaskCheck).toHaveBeenCalled();
  });

  it('runs the check when preTaskHeadSha is null (baseline unavailable)', async () => {
    const ctx: PerTaskContext = {
      sprintId: 's1',
      sprint: makeSprint(),
      task: makeTask(),
      preTaskHeadSha: null,
    };
    const { deps, runPostTaskCheck, getChangedFilesSince } = makeDeps(true);
    const result = await postTaskCheck(deps).execute(ctx);
    expect(result.ok).toBe(true);
    expect(runPostTaskCheck).toHaveBeenCalled();
    expect(getChangedFilesSince).not.toHaveBeenCalled();
  });
});
