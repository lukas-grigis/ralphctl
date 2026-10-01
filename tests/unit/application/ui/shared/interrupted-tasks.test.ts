import { describe, expect, it } from 'vitest';
import { interruptedTasksOf } from '@src/application/ui/shared/interrupted-tasks.ts';
import { makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

describe('interruptedTasksOf', () => {
  it('reports an in-progress task whose last attempt is still running', () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const [found] = interruptedTasksOf([task, makeTodoTask()], false);
    expect(found).toMatchObject({ taskId: task.id, name: task.name, attemptN: 1 });
    expect(found?.startedAt).toBe(Date.parse(task.attempts[0]?.startedAt ?? ''));
  });

  it('reports nothing while an implement run of this process owns the sprint', () => {
    expect(interruptedTasksOf([makeInProgressTaskWithRunningAttempt()], true)).toEqual([]);
  });

  it('ignores tasks that never started', () => {
    expect(interruptedTasksOf([makeTodoTask()], false)).toEqual([]);
  });
});
