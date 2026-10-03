import { describe, expect, it } from 'vitest';
import { interruptedTasksOf, stoppedTaskIds } from '@src/application/ui/shared/interrupted-tasks.ts';
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

describe('stoppedTaskIds', () => {
  const running = makeInProgressTaskWithRunningAttempt();
  const stopped = {
    ...running,
    attempts: running.attempts.map((a) => ({ ...a, status: 'aborted' as const, abortCause: 'user-cancel' as const })),
  };

  it('flags an in-progress task whose last attempt was aborted, with no live run', () => {
    expect([...stoppedTaskIds([stopped as never, makeTodoTask()], false)]).toEqual([running.id]);
    expect(interruptedTasksOf([stopped as never], false)).toEqual([]);
  });

  it('flags nothing while a live run works the sprint, or for a running attempt', () => {
    expect(stoppedTaskIds([stopped as never], true).size).toBe(0);
    expect(stoppedTaskIds([running], false).size).toBe(0);
  });
});
