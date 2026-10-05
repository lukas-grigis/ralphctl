import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { GitRunResult, GitRunner } from '@src/integration/io/git-runner.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  isSettledBlocked,
  quarantineBlockedDiffLeaf,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const CWD = absolutePath('/tmp/repo');
const PROGRESS = absolutePath('/tmp/sprint/progress.md');

/** Capturing AppendFile — records every (path, text) append for journal-pointer assertions. */
const capturingAppend = (): { fn: AppendFile; appended: Array<{ path: string; text: string }> } => {
  const appended: Array<{ path: string; text: string }> = [];
  return {
    appended,
    fn: async (path, text) => {
      appended.push({ path: String(path), text });
      return Result.ok(undefined);
    },
  };
};

const sprintId = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const BLOCKED_TODO = makeTodoTask({ name: 'A' });
const BLOCKED_ID = BLOCKED_TODO.id;

const blockedTask = (reason = 'verify failed: 2 tests red'): BlockedTask => {
  const r = markTaskBlocked(BLOCKED_TODO, reason, 'own');
  if (!r.ok) throw r.error;
  return r.value;
};

/**
 * Records every git argv issued. `gitStashPush` calls `status --porcelain` first, then (when dirty)
 * `stash push -u -m <msg>`; the inspect that follows lists the stack and shows the matched entry.
 * The fake answers status with the supplied dirtiness, lists one entry under the quarantine message,
 * and shows a two-file numstat — or fails the list when `inspectFails` is set.
 */
const recordingRunner = (opts: {
  dirty: boolean;
  inspectFails?: boolean;
}): GitRunner & { calls: readonly string[][] } => {
  const calls: string[][] = [];
  const ok = (stdout: string): Result<GitRunResult, StorageError> => Result.ok({ stdout, stderr: '', exitCode: 0 });
  return {
    calls,
    async run(_cwd: AbsolutePath, args: readonly string[]): Promise<Result<GitRunResult, StorageError>> {
      calls.push([...args]);
      // porcelain: one entry when dirty (a modified file), empty when clean.
      if (args[0] === 'status') return ok(opts.dirty ? ' M leftover.ts\n' : '');
      if (args[0] === 'stash' && args[1] === 'list') {
        if (opts.inspectFails === true) return Result.ok({ stdout: '', stderr: 'fatal: boom', exitCode: 128 });
        return ok(`stash@{0}\x1fOn main: ${quarantineStashMessage(sprintId, BLOCKED_ID)}\n`);
      }
      if (args[0] === 'stash' && args[1] === 'show') return ok('10\t2\tsrc/a.ts\n-\t-\tdocs/b.png\n');
      if (args[0] === 'stash') return ok('Saved working directory\n');
      return ok('');
    },
  };
};

const recordingRepo = (
  result: Result<void, StorageError> = Result.ok(undefined)
): UpdateTask & { saved: BlockedTask[]; calls: number } => {
  const state = {
    saved: [] as BlockedTask[],
    calls: 0,
    async update(_sprintId: SprintId, task: BlockedTask) {
      state.calls += 1;
      state.saved.push(task);
      return result;
    },
  };
  return state as unknown as UpdateTask & { saved: BlockedTask[]; calls: number };
};

describe('quarantineStashMessage', () => {
  it('is deterministic and names the sprint + task', () => {
    const task = blockedTask();
    const msg = quarantineStashMessage(sprintId, task.id);
    expect(msg).toBe(`ralphctl/${String(sprintId)}/${String(task.id)}/blocked-diff`);
    // Re-deriving yields the identical handle (no timestamp / positional ref).
    expect(quarantineStashMessage(sprintId, task.id)).toBe(msg);
  });
});

describe('isSettledBlocked', () => {
  it('is true for a blocked task whose attempt ran at least one gen-eval turn', () => {
    const blocked = blockedTask();
    const ctx: ImplementCtx = { sprintId, tasks: [blocked], genEvalTurn: 1 };
    expect(isSettledBlocked(ctx, blocked.id)).toBe(true);
  });

  it('is false for in_progress / missing tasks', () => {
    const inProgress = makeTodoTask({ name: 'B' });
    expect(isSettledBlocked({ sprintId, tasks: [inProgress], genEvalTurn: 1 }, inProgress.id)).toBe(false);
    expect(isSettledBlocked({ sprintId, tasks: [], genEvalTurn: 1 }, blockedTask().id)).toBe(false);
  });

  it('zero-turn discriminant: a task pre-blocked before ANY AI work never quarantines — the dirt is the operator\u2019s', () => {
    // Pre-task-verify hard-blocked (red baseline -> operator 'skip' / non-interactive): the
    // loop-entry guard spawned zero turns, so whatever dirties the tree is operator WIP —
    // possibly changes they explicitly chose to KEEP at the dirty-tree preflight. Stashing it
    // would override that choice and mislabel their work as a task-attributed rejected diff.
    const blocked = blockedTask('baseline already red at task start');
    const ctx: ImplementCtx = { sprintId, tasks: [blocked] }; // genEvalTurn undefined = zero turns
    expect(isSettledBlocked(ctx, blocked.id)).toBe(false);
  });
});

describe('quarantineBlockedDiffLeaf', () => {
  it('stashes the rejected diff and records the pointer on the blocked task (dirty tree)', async () => {
    const blocked = blockedTask('verify failed: 2 tests red');
    const runner = recordingRunner({ dirty: true });
    const repo = recordingRepo();
    const ctx: ImplementCtx = { sprintId, tasks: [blocked] };

    const res = await quarantineBlockedDiffLeaf(
      { gitRunner: runner, taskRepo: repo, appendFile: capturingAppend().fn, logger: noopLogger },
      { cwd: CWD, progressFile: PROGRESS },
      blocked.id
    ).execute(ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The stash was pushed with the deterministic message + `-u` (untracked included).
    const stashCall = runner.calls.find((c) => c[0] === 'stash');
    expect(stashCall).toStrictEqual(['stash', 'push', '-u', '-m', quarantineStashMessage(sprintId, blocked.id)]);
    // The pointer was persisted onto the blocked task and folded back into ctx.tasks.
    expect(repo.calls).toBe(1);
    const updated = res.value.ctx.tasks?.find((t) => t.id === blocked.id) as BlockedTask;
    expect(updated.status).toBe('blocked');
    expect(updated.blockedReason).toBe('verify failed: 2 tests red');
    // The stash was measured after the push: the newest entry's stat and the entry count ride along.
    expect(runner.calls.some((c) => c[0] === 'stash' && c[1] === 'show')).toBe(true);
    expect(updated.quarantinedDiff).toStrictEqual({
      stashMessage: quarantineStashMessage(sprintId, blocked.id),
      stat: { files: 2, insertions: 10, deletions: 2 },
      entries: 1,
    });
    expect(repo.saved[0]).toStrictEqual(updated);
  });

  it('records the pointer without a size when measuring the stash fails (best-effort)', async () => {
    const blocked = blockedTask();
    const runner = recordingRunner({ dirty: true, inspectFails: true });
    const repo = recordingRepo();

    const res = await quarantineBlockedDiffLeaf(
      { gitRunner: runner, taskRepo: repo, appendFile: capturingAppend().fn, logger: noopLogger },
      { cwd: CWD, progressFile: PROGRESS },
      blocked.id
    ).execute({ sprintId, tasks: [blocked] });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const updated = res.value.ctx.tasks?.find((t) => t.id === blocked.id) as BlockedTask;
    expect(updated.quarantinedDiff).toStrictEqual({ stashMessage: quarantineStashMessage(sprintId, blocked.id) });
    expect(repo.calls).toBe(1);
  });

  it('is a no-op when the tree is clean (no stash push, no repo write)', async () => {
    const blocked = blockedTask();
    const runner = recordingRunner({ dirty: false });
    const repo = recordingRepo();
    const ctx: ImplementCtx = { sprintId, tasks: [blocked] };

    const res = await quarantineBlockedDiffLeaf(
      { gitRunner: runner, taskRepo: repo, appendFile: capturingAppend().fn, logger: noopLogger },
      { cwd: CWD, progressFile: PROGRESS },
      blocked.id
    ).execute(ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(runner.calls.some((c) => c[0] === 'stash')).toBe(false);
    expect(repo.calls).toBe(0);
    // ctx untouched — reason unchanged.
    expect((res.value.ctx.tasks?.find((t) => t.id === blocked.id) as BlockedTask).blockedReason).toBe(
      blocked.blockedReason
    );
  });

  it('returns ok (best-effort) when the stash push errors — does NOT abort the run', async () => {
    const blocked = blockedTask();
    const runner: GitRunner = {
      async run(_cwd, args) {
        if (args[0] === 'status') return Result.ok({ stdout: ' M leftover.ts\n', stderr: '', exitCode: 0 });
        // stash push fails at the git level.
        return Result.ok({ stdout: '', stderr: 'fatal: cannot stash', exitCode: 1 });
      },
    };
    const repo = recordingRepo();
    const ctx: ImplementCtx = { sprintId, tasks: [blocked] };

    const res = await quarantineBlockedDiffLeaf(
      { gitRunner: runner, taskRepo: repo, appendFile: capturingAppend().fn, logger: noopLogger },
      { cwd: CWD, progressFile: PROGRESS },
      blocked.id
    ).execute(ctx);

    // Leaf swallows the git failure — the block already settled; aborting would strand later tasks.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(repo.calls).toBe(0);
    // ctx untouched on the swallowed-failure path.
    expect(res.value.ctx).toStrictEqual(ctx);
  });

  it('returns ok (best-effort) when recording the pointer fails — the diff is still stashed', async () => {
    const blocked = blockedTask();
    const runner = recordingRunner({ dirty: true });
    const repo = recordingRepo(Result.error(new StorageError({ subCode: 'io', message: 'tasks.json locked' })));
    const ctx: ImplementCtx = { sprintId, tasks: [blocked] };

    const res = await quarantineBlockedDiffLeaf(
      { gitRunner: runner, taskRepo: repo, appendFile: capturingAppend().fn, logger: noopLogger },
      { cwd: CWD, progressFile: PROGRESS },
      blocked.id
    ).execute(ctx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Stash WAS pushed; only the pointer-write failed → ctx left unchanged but the run continues.
    expect(runner.calls.some((c) => c[0] === 'stash')).toBe(true);
    expect(res.value.ctx).toStrictEqual(ctx);
  });
});
