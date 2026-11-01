import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { VerifyRun } from '@src/domain/entity/attempt.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { appendAttemptVerifyRun, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { markTaskBlocked, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { composeVerifyBlocks } from '@src/application/flows/implement/leaves/generator.ts';
import { absolutePath, FIXED_LATER, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import {
  isRedVerifyRetry,
  quarantineRetryDiffLeaf,
  retryStashMessage,
} from '@src/application/flows/implement/leaves/quarantine-retry-diff.ts';
import { REJECTED_DIFF_PATCH_MAX_BYTES } from '@src/application/flows/implement/leaves/verify-log.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`unwrap failed: ${String(r.error)}`);
  return r.value as T;
};

const SPRINT_ID = 'sprint-x' as SprintId;
const SPRINT_DIR = absolutePath('/data/sprints/sprint-x');
const PATCH = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';

/** Records git argv calls; scripted stash behaviour. */
const fakeGit = (opts?: {
  dirty?: boolean;
  fail?: boolean;
  patch?: string;
  showFails?: boolean;
}): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  let pushedMessage: string | undefined;
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      if (opts?.fail === true) return Result.error(new StorageError({ subCode: 'io', message: 'git broke' }));
      // gitStashPush probes cleanliness first (`git status --porcelain`) and only stashes a dirty tree.
      if (args[0] === 'status') {
        return Result.ok({ stdout: opts?.dirty === true ? ' M src/x.ts\n?? src/new.ts' : '', stderr: '', exitCode: 0 });
      }
      if (args[1] === 'push') pushedMessage = args[args.length - 1];
      if (args[1] === 'list' && pushedMessage !== undefined) {
        return Result.ok({ stdout: `stash@{0}\x1fOn main: ${pushedMessage}\n`, stderr: '', exitCode: 0 });
      }
      if (args[1] === 'show') {
        if (opts?.showFails === true) return Result.ok({ stdout: '', stderr: 'fatal: bad', exitCode: 128 });
        return Result.ok({ stdout: opts?.patch ?? PATCH, stderr: '', exitCode: 0 });
      }
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
};

const recordingWriteFile = (fail = false): { writeFile: WriteFile; writes: Array<[string, string]> } => {
  const writes: Array<[string, string]> = [];
  const writeFile: WriteFile = (path, content) => {
    writes.push([String(path), content]);
    return Promise.resolve(
      fail ? Result.error(new StorageError({ subCode: 'io', message: 'disk full' })) : Result.ok(undefined)
    );
  };
  return { writeFile, writes };
};

const warnLogger = (): { logger: Logger; warns: string[] } => {
  const warns: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    named: () => ({
      ...noopLogger,
      warn: (msg: string) => {
        warns.push(msg);
      },
    }),
  };
  return { logger, warns };
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
  const OPTS = { cwd: absolutePath('/repos/main'), sprintDir: SPRINT_DIR };

  it('stashes the rejected diff under the attempt-scoped deterministic message', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner, calls } = fakeGit({ dirty: true });
    const { writeFile } = recordingWriteFile();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);

    const out = await el.execute(ctxFor(task));

    expect(out.ok).toBe(true);
    const stash = calls.find((c) => c[0] === 'stash');
    expect(stash).toBeDefined();
    expect(stash?.join(' ')).toContain(retryStashMessage(SPRINT_ID, task.id, task.attempts.length));
  });

  it('saves the stashed diff as a patch at the attempt-scoped path', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: true });
    const { writeFile, writes } = recordingWriteFile();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);

    expect((await el.execute(ctxFor(task))).ok).toBe(true);
    expect(writes).toEqual([
      [
        `/data/sprints/sprint-x/logs/rejected-diff/${String(task.id)}/attempt-${String(task.attempts.length)}.patch`,
        PATCH,
      ],
    ]);
  });

  describe('after an unblock restarted the attempt numbers', () => {
    const redPost: VerifyRun = {
      phase: 'post',
      ranAt: FIXED_LATER,
      command: 'pnpm verify',
      exitCode: 1,
      durationMs: 1,
      outcome: 'failed',
    };

    /** The real path to the task's first attempt after an unblock: the blocked run's one attempt is archived. */
    const revived = (): InProgressTask => {
      const failed = unwrap(failCurrentAttempt(makeInProgressTaskWithRunningAttempt(), FIXED_LATER, 'failed'));
      const todo = unwrap(unblockTask(unwrap(markTaskBlocked(failed, 'stuck', 'own'))));
      return unwrap(startNextAttempt(todo, FIXED_LATER, 'session-2'));
    };

    it('numbers the patch past the retired attempts', async () => {
      const task = revived();
      expect(task.attempts).toHaveLength(1);
      const { runner } = fakeGit({ dirty: true });
      const { writeFile, writes } = recordingWriteFile();
      const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);

      expect((await el.execute(ctxFor(task))).ok).toBe(true);
      expect(writes.map(([path]) => path)).toEqual([
        `/data/sprints/sprint-x/logs/rejected-diff/${String(task.id)}/attempt-2.patch`,
      ]);
    });

    it('writes the patch where the next attempt reads it', async () => {
      const task = unwrap(appendAttemptVerifyRun(revived(), redPost));
      const { runner } = fakeGit({ dirty: true });
      const { writeFile, writes } = recordingWriteFile();
      const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);
      expect((await el.execute(ctxFor(task))).ok).toBe(true);

      const retry = unwrap(startNextAttempt(unwrap(failCurrentAttempt(task, FIXED_LATER, 'failed')), FIXED_LATER));
      const written = new Map(writes);
      const { retryFeedback } = await composeVerifyBlocks(
        (path) => Promise.resolve(written.get(String(path))),
        SPRINT_DIR,
        retry.id,
        retry
      );

      expect(retryFeedback).toContain(`\`git apply "${writes[0]?.[0] ?? 'nothing written'}"\``);
    });
  });

  it('skips (does not truncate) a patch over the cap — warns, still ok', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: true, patch: 'x'.repeat(REJECTED_DIFF_PATCH_MAX_BYTES + 1) });
    const { writeFile, writes } = recordingWriteFile();
    const { logger, warns } = warnLogger();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger, writeFile }, OPTS, task.id);

    expect((await el.execute(ctxFor(task))).ok).toBe(true);
    expect(writes).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it('a failed stash show warns and writes nothing — still ok', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: true, showFails: true });
    const { writeFile, writes } = recordingWriteFile();
    const { logger, warns } = warnLogger();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger, writeFile }, OPTS, task.id);

    expect((await el.execute(ctxFor(task))).ok).toBe(true);
    expect(writes).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it('a failed patch write warns — still ok', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: true });
    const { writeFile } = recordingWriteFile(true);
    const { logger, warns } = warnLogger();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger, writeFile }, OPTS, task.id);

    expect((await el.execute(ctxFor(task))).ok).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it('git failure is best-effort — leaf still returns ok (retry already granted)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ fail: true });
    const { writeFile, writes } = recordingWriteFile();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);

    const out = await el.execute(ctxFor(task));
    expect(out.ok).toBe(true);
    expect(writes).toEqual([]);
  });

  it('clean tree no-ops without error and writes no patch (the green-verify retry shape)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const { runner } = fakeGit({ dirty: false });
    const { writeFile, writes } = recordingWriteFile();
    const el = quarantineRetryDiffLeaf({ gitRunner: runner, logger: noopLogger, writeFile }, OPTS, task.id);

    const out = await el.execute(ctxFor(task));
    expect(out.ok).toBe(true);
    expect(writes).toEqual([]);
  });
});
