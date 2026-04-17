import { describe, it, expect, vi } from 'vitest';
import { ParseError } from '@src/domain/errors.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
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

  it('forwards resumeSessionId from taskSessionIds map into executeOneTask options', async () => {
    const captured: { options?: ExecutionOptions }[] = [];
    const useCase = {
      executeOneTask: vi.fn((_task: Task, _sprint: Sprint, options?: ExecutionOptions) => {
        captured.push({ options });
        return Promise.resolve({
          taskId: 't1',
          success: true,
          output: 'ok',
          verified: true,
        } satisfies TaskExecutionResult);
      }),
    } as unknown as ExecuteTasksUseCase;

    const taskSessionIds = new Map<string, string>([['t1', 'resume-abc-123']]);
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };

    const stepResult = await executeTask({
      useCase,
      options: { maxRetries: 5 },
      taskSessionIds,
    }).execute(ctx);

    expect(stepResult.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.options?.resumeSessionId).toBe('resume-abc-123');
    // Existing options are preserved, not replaced.
    expect(captured[0]?.options?.maxRetries).toBe(5);
  });

  it('omits resumeSessionId when the taskSessionIds map has no entry for the task', async () => {
    const captured: { options?: ExecutionOptions }[] = [];
    const useCase = {
      executeOneTask: vi.fn((_task: Task, _sprint: Sprint, options?: ExecutionOptions) => {
        captured.push({ options });
        return Promise.resolve({
          taskId: 't1',
          success: true,
          output: 'ok',
          verified: true,
        } satisfies TaskExecutionResult);
      }),
    } as unknown as ExecuteTasksUseCase;

    const taskSessionIds = new Map<string, string>(); // empty
    const ctx: PerTaskContext = { sprintId: 's1', sprint: makeSprint(), task: makeTask() };

    const stepResult = await executeTask({
      useCase,
      options: {},
      taskSessionIds,
    }).execute(ctx);

    expect(stepResult.ok).toBe(true);
    expect(captured[0]?.options?.resumeSessionId).toBeUndefined();
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
