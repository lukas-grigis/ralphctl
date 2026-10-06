import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  interruptedTasksOf,
  loadInterruptedFacts,
  stoppedTaskIds,
} from '@src/application/ui/shared/interrupted-tasks.ts';
import { stampPriorWorkOutcome } from '@src/domain/entity/task-prior-work.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  absolutePath,
  makeActiveSprint,
  makeInProgressTaskWithRunningAttempt,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

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

describe('loadInterruptedFacts — restored prior work', () => {
  const statusOnlyGit = (): GitRunner & { calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      run: (_cwd, args) => {
        calls.push([...args]);
        return Promise.resolve(Result.ok({ stdout: ' M a.ts\n', stderr: '', exitCode: 0 }));
      },
    };
  };

  const load = async (task: InProgressTask): Promise<{ restored: boolean | undefined; gitCalls: string[][] }> => {
    const git = statusOnlyGit();
    const facts = await loadInterruptedFacts(
      { gitRunner: git, dataRoot: absolutePath('/nonexistent/ralphctl-data') },
      makeProject(),
      makeActiveSprint(),
      [task],
      interruptedTasksOf([task], false)
    );
    return { restored: facts.get(task.id)?.restoredPriorWork, gitCalls: git.calls };
  };

  it('reads it off the task — the interrupted attempt popped its rejected diff, so the tree holds the only copy', async () => {
    const stamped = stampPriorWorkOutcome(makeInProgressTaskWithRunningAttempt(), {
      kind: 'restored',
      stashMessage: 'ralphctl/s/t/blocked-diff',
    });
    if (!stamped.ok) throw stamped.error;

    const { restored, gitCalls } = await load(stamped.value);

    expect(restored).toBe(true);
    // Only the existing uncommitted-changes probe — the fact costs no git call of its own.
    expect(gitCalls.every((c) => c[0] === 'status')).toBe(true);
    expect(gitCalls).toHaveLength(1);
  });

  it('is false when the attempt restored nothing', async () => {
    expect((await load(makeInProgressTaskWithRunningAttempt())).restored).toBe(false);
  });
});
