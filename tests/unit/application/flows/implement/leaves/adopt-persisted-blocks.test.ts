import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';

import { createRunner } from '@src/application/chain/run/runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { adoptPersistedBlocksLeaf } from '@src/application/flows/implement/leaves/adopt-persisted-blocks.ts';

import { makeInProgressTaskWithRunningAttempt, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

interface RecordingLogger extends Logger {
  readonly warnings: Array<{ readonly message: string; readonly meta?: unknown }>;
}

const recordingLogger = (): RecordingLogger => {
  const warnings: RecordingLogger['warnings'] = [];
  const self: RecordingLogger = {
    warnings,
    debug() {},
    info() {},
    warn(message, meta) {
      warnings.push({ message, meta });
    },
    error() {},
    named: () => self,
  };
  return self;
};

const fakeFindTasksBySprintId = (
  result: Result<readonly Task[], StorageError> | { readonly throws: unknown }
): FindTasksBySprintId => ({
  findBySprintId: async (_sprintId: SprintId) => {
    void _sprintId;
    if ('throws' in result) throw result.throws;
    return result;
  },
});

const sprint = makePlannedSprint();
const baseCtx = (tasks: readonly Task[] | undefined): ImplementCtx => ({ sprintId: sprint.id, sprint, tasks });

const run = async (
  taskRepo: FindTasksBySprintId,
  logger: Logger,
  tasks: readonly Task[] | undefined
): Promise<{ status: string; ctx: ImplementCtx }> => {
  const runner = createRunner<ImplementCtx>({
    id: 'epilogue',
    element: adoptPersistedBlocksLeaf({ taskRepo, logger }),
    initialCtx: baseCtx(tasks),
  });
  await runner.start();
  return { status: runner.status, ctx: runner.ctx };
};

const blockedFrom = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): Task => {
  const result = markTaskBlocked(task, 'attempt budget exhausted', 'own');
  if (!result.ok) throw new Error('fixture: markTaskBlocked failed');
  return result.value;
};

describe('adoptPersistedBlocksLeaf', () => {
  it('adopts a persisted block onto ctx.tasks', async () => {
    const resumed = makeInProgressTaskWithRunningAttempt();
    const persisted = blockedFrom(resumed);
    const taskRepo = fakeFindTasksBySprintId(Result.ok([persisted]));

    const { status, ctx } = await run(taskRepo, recordingLogger(), [resumed]);

    expect(status).toBe('completed');
    expect(ctx.tasks?.[0]).toBe(persisted);
  });

  it('returns ok with the SAME tasks reference and logs a warn when the read fails (Result.error)', async () => {
    const t = makeTodoTask();
    const logger = recordingLogger();
    const readError = new StorageError({ subCode: 'io', message: 'tasks.json unreadable' });
    const taskRepo = fakeFindTasksBySprintId(Result.error(readError));
    const tasks = [t];

    const { status, ctx } = await run(taskRepo, logger, tasks);

    expect(status).toBe('completed');
    expect(ctx.tasks).toBe(tasks);
    expect(logger.warnings).toHaveLength(1);
  });

  it('returns ok and logs a warn when the port THROWS a non-AbortError', async () => {
    const t = makeTodoTask();
    const logger = recordingLogger();
    const taskRepo = fakeFindTasksBySprintId({ throws: new Error('adapter exploded') });
    const tasks = [t];

    const { status, ctx } = await run(taskRepo, logger, tasks);

    expect(status).toBe('completed');
    expect(ctx.tasks).toBe(tasks);
    expect(logger.warnings).toHaveLength(1);
  });

  it('propagates an AbortError thrown by the port rather than swallowing it', async () => {
    const t = makeTodoTask();
    const taskRepo = fakeFindTasksBySprintId({ throws: new AbortError({ elementName: 'adopt-persisted-blocks' }) });

    const { status } = await run(taskRepo, recordingLogger(), [t]);

    expect(status).toBe('aborted');
  });

  it('is a no-op — the port is never called — when ctx.tasks is undefined', async () => {
    let called = false;
    const taskRepo: FindTasksBySprintId = {
      findBySprintId: async () => {
        called = true;
        return Result.ok([]);
      },
    };

    const { status, ctx } = await run(taskRepo, recordingLogger(), undefined);

    expect(status).toBe('completed');
    expect(ctx.tasks).toBeUndefined();
    expect(called).toBe(false);
  });
});
