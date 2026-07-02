import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { type CommitTaskProps, commitTaskUseCase } from '@src/business/task/commit-task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const CWD = absolutePath('/tmp/repo');

const sprintId = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const fakeRepo = (): UpdateTask & { calls: number } => ({
  calls: 0,
  async update() {
    (this as unknown as { calls: number }).calls += 1;
    return Result.ok(undefined);
  },
});

describe('commitTaskUseCase', () => {
  it('clean tree ({ committed: false }) returns ok with no sha and does not persist', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    // The discriminated union means the `committed: false` variant carries no headSha at all.
    const gitCommit: CommitTaskProps['gitCommit'] = async () => Result.ok({ committed: false });
    const result = await commitTaskUseCase({
      task,
      sprintId,
      message: 'msg',
      cwd: CWD,
      gitCommit,
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sha).toBeUndefined();
    expect(repo.calls).toBe(0);
  });

  it('dirty tree ({ committed: true, headSha }) records the sha on the attempt and persists', async () => {
    const repo = fakeRepo();
    const task = makeInProgressTaskWithRunningAttempt();
    const sha = 'a'.repeat(40);
    // The `committed: true` variant makes headSha a required non-optional string — no `!` needed
    // downstream, the compiler guarantees it is present.
    const gitCommit: CommitTaskProps['gitCommit'] = async () => Result.ok({ committed: true, headSha: sha });
    const result = await commitTaskUseCase({
      task,
      sprintId,
      message: 'msg',
      cwd: CWD,
      gitCommit,
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sha).toBe(sha);
      expect(result.value.task.attempts.at(-1)?.commitSha).toBe(sha);
    }
    expect(repo.calls).toBe(1);
  });
});
