import { describe, it, expect, vi } from 'vitest';
import { ParseError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExecuteTasksUseCase, TaskExecutionResult } from '@src/business/usecases/execute.ts';
import { executeTask } from './execute-task.ts';
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
    status: 'todo',
    order: 1,
    blockedBy: [],
    projectPath: '/repo',
    verified: false,
    evaluated: false,
  };
}

function makeUseCase(result: TaskExecutionResult): ExecuteTasksUseCase {
  return {
    executeOneTask: vi.fn(() => Promise.resolve(result)),
  } as unknown as ExecuteTasksUseCase;
}

describe('executeTask step', () => {
  it('writes executionResult and generatorModel on success', async () => {
    const result: TaskExecutionResult = {
      taskId: 't1',
      success: true,
      output: 'ok',
      verified: true,
      verificationOutput: 'verified body',
      model: 'claude-sonnet',
    };
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };

    const stepResult = await executeTask({ useCase: makeUseCase(result), options: {} }).execute(ctx);
    expect(stepResult.ok).toBe(true);
    if (!stepResult.ok) return;
    expect(stepResult.value.executionResult).toEqual(result);
    expect(stepResult.value.generatorModel).toBe('claude-sonnet');
  });

  it('returns ParseError when executeOneTask reports success: false', async () => {
    const result: TaskExecutionResult = {
      taskId: 't1',
      success: false,
      output: '',
      blocked: 'needs human input',
    };
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };

    const stepResult = await executeTask({ useCase: makeUseCase(result), options: {} }).execute(ctx);
    expect(stepResult.ok).toBe(false);
    if (stepResult.ok) return;
    expect(stepResult.error).toBeInstanceOf(ParseError);
    expect(stepResult.error.message).toContain('needs human input');
  });
});
