import { describe, it, expect, vi } from 'vitest';
import { ParseError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { postTaskCheck } from './post-task-check.ts';
import type { PerTaskContext } from '../per-task-context.ts';

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
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
    projectPath: '/repo',
    verified: false,
    evaluated: false,
  };
}

function makeUseCase(passed: boolean): ExecuteTasksUseCase {
  return { runPostTaskCheck: vi.fn(() => Promise.resolve(passed)) } as unknown as ExecuteTasksUseCase;
}

describe('postTaskCheck step', () => {
  it('passes when the check returns true', async () => {
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const result = await postTaskCheck({ useCase: makeUseCase(true) }).execute(ctx);
    expect(result.ok).toBe(true);
  });

  it('returns ParseError when the check returns false', async () => {
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };
    const result = await postTaskCheck({ useCase: makeUseCase(false) }).execute(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('Task 1');
  });
});
