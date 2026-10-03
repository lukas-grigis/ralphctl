import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { createSettleAbandonedAttempts } from '@src/business/task/settle-abandoned-attempts.ts';
import { FIXED_LATER, FIXED_LATEST, FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = 'sprint-x' as SprintId;

const runningSince = (startedAt: typeof FIXED_NOW, name: string): Task => {
  const started = startNextAttempt(makeTodoTask({ name }), startedAt);
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
};

describe('createSettleAbandonedAttempts', () => {
  it("settles only the stopped run's own running attempts as operator-cancelled", async () => {
    const mine = runningSince(FIXED_LATER, 'opened by the stopped run');
    const older = runningSince(FIXED_NOW, 'left by an earlier crash');
    const idle = makeTodoTask({ name: 'not started' });
    const writes: Task[] = [];
    const settle = createSettleAbandonedAttempts({
      taskRepo: {
        findBySprintId: () => Promise.resolve(Result.ok([mine, older, idle])),
        update: (_sprintId, task) => {
          writes.push(task);
          return Promise.resolve(Result.ok(undefined));
        },
      },
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    const result = await settle.execute({ sprintId: SPRINT_ID, since: Date.parse(FIXED_LATER) });

    expect(result.ok && result.value).toEqual([mine.id]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe('in_progress');
    expect(writes[0]?.attempts.at(-1)).toMatchObject({ status: 'aborted', abortCause: 'user-cancel' });
  });
});
