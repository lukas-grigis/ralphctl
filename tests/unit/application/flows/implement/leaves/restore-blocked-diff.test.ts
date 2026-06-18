import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { restoreBlockedDiffLeaf } from '@src/application/flows/implement/leaves/restore-blocked-diff.ts';

const SPRINT_ID = 'sprint-x' as SprintId;
const TASK_ID = 'task-1' as TaskId;

/**
 * Records git argv calls; scripts `stash list --format=%s` to contain `stashed` and lets
 * `stash pop` either succeed or fail per `popFails`.
 */
const fakeGit = (opts?: {
  stashed?: string[];
  popFails?: boolean;
  listFails?: boolean;
}): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      if (args[0] === 'stash' && args[1] === 'list') {
        if (opts?.listFails === true) return Result.error(new StorageError({ subCode: 'io', message: 'git broke' }));
        return Result.ok({ stdout: (opts?.stashed ?? []).join('\n'), stderr: '', exitCode: 0 });
      }
      if (args[0] === 'stash' && args[1] === 'pop') {
        if (opts?.popFails === true) return Result.ok({ stdout: '', stderr: 'merge conflict', exitCode: 1 });
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
};

const ctx: ImplementCtx = { sprintId: SPRINT_ID };

describe('restoreBlockedDiffLeaf', () => {
  it('pops the deterministic stash when a prior blocked diff is present', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [message] });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(true);
  });

  it('does not pop when no matching stash exists (clean-tree retry)', async () => {
    const { runner, calls } = fakeGit({ stashed: ['ralphctl/sprint-x/task-other/blocked-diff'] });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(false);
  });

  it('is best-effort — a failed pop still returns ok', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner } = fakeGit({ stashed: [message], popFails: true });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
  });
});
