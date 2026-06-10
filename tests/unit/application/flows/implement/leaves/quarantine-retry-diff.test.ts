import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import {
  isRedVerifyRetry,
  quarantineRetryDiffLeaf,
  retryStashMessage,
} from '@src/application/flows/implement/leaves/quarantine-retry-diff.ts';

const SPRINT_ID = 'sprint-x' as SprintId;

/** Records git argv calls; scripted stash behaviour. */
const fakeGit = (opts?: { dirty?: boolean; fail?: boolean }): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      if (opts?.fail === true) return Result.error(new StorageError({ subCode: 'io', message: 'git broke' }));
      // gitStashPush probes cleanliness first (`git status --porcelain`) and only stashes a dirty tree.
      if (args[0] === 'status') {
        return Result.ok({ stdout: opts?.dirty === true ? ' M src/x.ts\n?? src/new.ts' : '', stderr: '', exitCode: 0 });
      }
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
};

describe('isRedVerifyRetry — composed-case guard', () => {
  const base: ImplementCtx = { sprintId: SPRINT_ID };

  it('fires ONLY when a granted retry co-occurs with a block reason', () => {
    expect(isRedVerifyRetry({ ...base, lastShouldFailAttempt: true, lastBlockReason: 'regressed' })).toBe(true);
  });

  it('stays silent on the plain retry path (green verify — nothing to stash)', () => {
    expect(isRedVerifyRetry({ ...base, lastShouldFailAttempt: true })).toBe(false);
  });

  it('stays silent on the plain block path (self-block / pre-verify — settle blocks, blocked-diff quarantine owns cleanup)', () => {
    expect(isRedVerifyRetry({ ...base, lastBlockReason: 'self-blocked' })).toBe(false);
  });
});

describe('quarantineRetryDiffLeaf', () => {
  const ctxFor = (dirtyTask = makeInProgressTaskWithRunningAttempt()): ImplementCtx => ({
    sprintId: SPRINT_ID,
    tasks: [dirtyTask],
    currentTask: dirtyTask,
    currentTaskId: dirtyTask.id,
    lastShouldFailAttempt: true,
    lastBlockReason: 'verify failed after task: regressed (exit 1)',
  });

  it('stashes the rejected diff under the attempt-scoped deterministic message', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner, calls } = fakeGit({ dirty: true });
    const el = quarantineRetryDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      task.id
    );

    const out = await el.execute(ctxFor(task));

    expect(out.ok).toBe(true);
    const stash = calls.find((c) => c[0] === 'stash');
    expect(stash).toBeDefined();
    expect(stash?.join(' ')).toContain(retryStashMessage(SPRINT_ID, task.id, task.attempts.length));
  });

  it('git failure is best-effort — leaf still returns ok (retry already granted)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ fail: true });
    const el = quarantineRetryDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      task.id
    );

    const out = await el.execute(ctxFor(task));
    expect(out.ok).toBe(true);
  });

  it('clean tree no-ops without error (the green-verify retry shape)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: false });
    const el = quarantineRetryDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      task.id
    );

    const out = await el.execute(ctxFor(task));
    expect(out.ok).toBe(true);
  });
});
