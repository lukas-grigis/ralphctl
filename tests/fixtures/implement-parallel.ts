import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { recordRunningAttemptCommit } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';

import { leaf } from '@src/application/chain/build/leaf.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Shared fakes for the parallel-implement test suites (`wave-branch-blocked-cleanup.test.ts`, the
 * `parallel-element.test.ts` durable-blocks-survive-the-epilogue cases, and any future case that
 * needs a real per-task subchain over a fake git + task repository). Extracted from
 * `wave-branch-blocked-cleanup.test.ts` so both files script the SAME fakes rather than two copies
 * drifting apart.
 */

export type RecordingTaskRepo = TaskRepository & { calls: number; saved: Task[] };

/**
 * An in-memory task store seeded with `seed`: records every (sprintId, task) passed to `update` —
 * the pointer-persistence side of quarantine — and serves the latest written copy from `findById` /
 * `findBySprintId`, which is what the worktree teardown and `adopt-persisted-blocksLeaf` read.
 * `lookup` makes the `findById` read fail (a `StorageError` result) or throw outright; it does NOT
 * affect `findBySprintId` (the epilogue-reconciliation read), which always succeeds against the
 * current rows — no caller needs it to fail yet.
 */
export const recordingTaskRepo = (
  seed: readonly Task[] = [],
  lookup: { readonly fails?: StorageError; readonly throws?: Error } = {}
): RecordingTaskRepo => {
  const rows = new Map<string, Task>(seed.map((t) => [String(t.id), t]));
  const state = {
    calls: 0,
    saved: [] as Task[],
    async update(_sprintId: SprintId, task: Task) {
      state.calls += 1;
      state.saved.push(task);
      rows.set(String(task.id), task);
      return Result.ok(undefined);
    },
    async findById(_sprintId: SprintId, taskId: TaskId) {
      if (lookup.throws !== undefined) throw lookup.throws;
      if (lookup.fails !== undefined) return Result.error(lookup.fails);
      const row = rows.get(String(taskId));
      return row !== undefined
        ? Result.ok(row)
        : Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
    },
    async findBySprintId(_sprintId: SprintId) {
      void _sprintId;
      return Result.ok([...rows.values()]);
    },
    async saveAll(_sprintId: SprintId, tasks: readonly Task[]) {
      rows.clear();
      for (const task of tasks) rows.set(String(task.id), task);
      return Result.ok(undefined);
    },
  };
  return state as unknown as RecordingTaskRepo;
};

/**
 * One scripted `git stash list --format=%s` answer: the stash messages present (rendered the way
 * real git renders them, `On <branch>: <message>`), or a failed listing.
 */
export type StashListAnswer = { readonly messages: readonly string[] } | { readonly failsWith: string };

/**
 * A git runner that records `(cwd, argv)` for every call — cwd matters for these suites (the whole
 * point of the quarantine fix is that the stash runs against the WORKTREE, never `repo.path`).
 * Answers `status --porcelain` per `opts.dirty`, `merge --ff-only` / `cherry-pick` per
 * `opts.foldConflict`, and every other stash / worktree / branch call with success.
 *
 * `stash list` answers come off `opts.stashList` in call order — one entry per call, an empty stack
 * once the queue runs dry (and by default). The fake never updates that queue itself, so a test
 * scripts the stack each list call should observe.
 *
 * Matches on `args[0]` / `args[1]` only, never the full argv — a sibling test group is changing
 * `gitStatusPorcelain`'s trailing flags concurrently.
 */
export const fakeGitRecordingCwd = (
  opts: { dirty?: boolean; foldConflict?: boolean; stashList?: readonly StashListAnswer[] } = {}
): { runner: GitRunner; calls: Array<{ cwd: string; args: string[] }> } => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const stashList = [...(opts.stashList ?? [])];
  const ok = (stdout = '', exitCode = 0, stderr = ''): Result<GitRunResult, StorageError> =>
    Result.ok({ stdout, stderr, exitCode });
  const conflict = (): Result<GitRunResult, StorageError> => ok('CONFLICT (content)', 1, 'cherry-pick failed');
  const listStash = (): Result<GitRunResult, StorageError> => {
    const answer = stashList.shift() ?? { messages: [] };
    if ('failsWith' in answer) return ok('', 128, answer.failsWith);
    return ok(answer.messages.map((m) => `On ralphctl/s1/wt-x: ${m}\n`).join(''));
  };
  const runner: GitRunner = {
    async run(cwd, args) {
      calls.push({ cwd: String(cwd), args: [...args] });
      const [a, b] = args;
      if (a === 'status') {
        // `-z` records are NUL-terminated, plain ones newline-terminated — as real git prints them.
        return ok(opts.dirty === true ? ` M leftover.ts${args.includes('-z') ? '\0' : '\n'}` : '');
      }
      if (a === 'stash' && b === 'list') return listStash();
      if (a === 'merge' && b === '--ff-only') return opts.foldConflict === true ? ok('not ff', 1) : ok();
      if (a === 'merge-base') return ok('a'.repeat(40));
      if (a === 'cherry-pick') return opts.foldConflict === true ? conflict() : ok();
      return ok(); // worktree add/remove/prune, branch -D, stash push — all succeed.
    },
  };
  return { runner, calls };
};

/**
 * A real leaf that records a commit on the task's running attempt and persists it — what
 * `commit-task` leaves on disk once it landed the attempt's work, before anything settles.
 */
export const commitLandsIn = (
  name: string,
  taskRepo: TaskRepository,
  sprintId: SprintId,
  taskId: TaskId,
  sha: CommitSha
): Element<ImplementCtx> =>
  leaf<ImplementCtx, undefined, undefined>(name, {
    useCase: {
      execute: async () => {
        const current = await taskRepo.findById(sprintId, taskId);
        if (!current.ok || current.value.status !== 'in_progress') throw new Error('test setup: task not in progress');
        const committed = recordRunningAttemptCommit(current.value, sha);
        if (!committed.ok) throw committed.error;
        await taskRepo.update(sprintId, committed.value);
        return Result.ok(undefined);
      },
    },
    input: () => undefined,
    output: (ctx) => ctx,
  });

/**
 * A real leaf that settles the task's running attempt as failed with budget left, the way
 * `settle-attempt` does before the attempt loop opens another one: persisted, and projected back
 * onto `ctx.tasks` so the next `start-attempt` finds no running attempt.
 */
export const attemptSettlesForRetry = (
  taskRepo: TaskRepository,
  sprintId: SprintId,
  taskId: TaskId,
  now: IsoTimestamp
): Element<ImplementCtx> =>
  leaf<ImplementCtx, undefined, Task>(`settle-attempt-${String(taskId)}`, {
    useCase: {
      execute: async () => {
        const current = await taskRepo.findById(sprintId, taskId);
        if (!current.ok) throw current.error;
        const settled = failCurrentAttempt(current.value, now, 'failed');
        if (!settled.ok) throw settled.error;
        if (settled.value.status !== 'in_progress') throw new Error('test setup: the attempt budget ran out');
        await taskRepo.update(sprintId, settled.value);
        return Result.ok(settled.value);
      },
    },
    input: () => undefined,
    output: (ctx, task) => ({ ...ctx, tasks: (ctx.tasks ?? []).map((t) => (t.id === task.id ? task : t)) }),
  });

/** A real leaf whose use case is where the Ctrl-C lands: `leaf.ts` then reports it as aborted. */
export const abortLandsIn = (name: string, controller: AbortController): Element<ImplementCtx> =>
  leaf<ImplementCtx, undefined, undefined>(name, {
    useCase: {
      execute: async () => {
        controller.abort();
        return Result.ok(undefined);
      },
    },
    input: () => undefined,
    output: (ctx) => ctx,
  });

/**
 * What the gen-eval loop + finalize leave on ctx for a turn that ended in a block — a fake stand-in
 * for the real generator/evaluator/finalize leaves, parametrised on the block reason so each caller
 * can assert against its own literal.
 */
export const turnEndedBlocked = (reason: string): Element<ImplementCtx> => ({
  name: 'fake-gen-eval',
  async execute(ctx) {
    return Result.ok({
      ctx: { ...ctx, genEvalTurn: 1, lastVerdict: 'failed', lastBlockReason: reason },
      trace: [],
    });
  },
});

/** Controls for {@link scriptedWorktreeTree}. */
export interface ScriptedWorktreeTreeOpts {
  /** The worktree cwd whose tree is modelled. Every call for another cwd goes to `inner`. */
  readonly cwd: string;
  /** Porcelain records already in the tree, e.g. `' M pnpm-lock.yaml'`, `'?? gen/'`. */
  readonly initial?: readonly string[];
  /** Answers every call the tree does not model. Default: exit 0, no output. */
  readonly inner?: GitRunner;
  /** 1-based `status -z` calls against `cwd` that exit 128 instead of answering. */
  readonly statusFailsOn?: readonly number[];
  /** `restore` exits 1 without touching the tree. */
  readonly restoreFails?: boolean;
  /** `restore` / `clean` exit 0 but leave the tree as it was (a nested repo `clean` skips, …). */
  readonly discardIsNoop?: boolean;
}

export interface ScriptedWorktreeTree {
  readonly runner: GitRunner;
  /** The modelled tree's current records — a fake setup script adds to it. */
  readonly lines: Set<string>;
  /** Every call against the modelled cwd, in order. */
  readonly calls: string[][];
}

/**
 * A git runner modelling ONE worktree's porcelain tree, for the per-worktree setup check: answers
 * `status` (NUL-terminated for `-z`, newline-terminated otherwise) from `lines`, and removes the
 * matching records on the path-scoped `restore` / `clean` discard. Every call for another cwd — and
 * every other verb — goes to `opts.inner`. Matches on `args[0]` plus the `-z` flag only.
 */
export const scriptedWorktreeTree = (opts: ScriptedWorktreeTreeOpts): ScriptedWorktreeTree => {
  const lines = new Set(opts.initial ?? []);
  const calls: string[][] = [];
  const failOn = new Set(opts.statusFailsOn ?? []);
  let zStatusCalls = 0;
  const reply = (stdout: string, exitCode = 0, stderr = ''): Result<GitRunResult, StorageError> =>
    Result.ok({ stdout, stderr, exitCode });
  const literalPaths = (args: readonly string[]): Set<string> =>
    new Set(args.slice(args.indexOf('--') + 1).map((spec) => spec.replace(/^:\(literal\)/, '')));
  const drop = (keep: (record: string) => boolean): void => {
    for (const record of [...lines]) if (!keep(record)) lines.delete(record);
  };
  const runner: GitRunner = {
    async run(cwd, args, runOpts) {
      if (String(cwd) !== opts.cwd) return opts.inner?.run(cwd, args, runOpts) ?? reply('');
      calls.push([...args]);
      const [verb] = args;
      if (verb === 'status') {
        const z = args.includes('-z');
        if (z) zStatusCalls += 1;
        if (z && failOn.has(zStatusCalls)) return reply('', 128, 'fatal: index file corrupt');
        return reply([...lines].map((l) => `${l}${z ? '\0' : '\n'}`).join(''));
      }
      if (verb === 'restore') {
        if (opts.restoreFails === true) return reply('', 1, 'error: pathspec did not match any file(s) known to git');
        const paths = literalPaths(args);
        if (opts.discardIsNoop !== true) drop((r) => r.startsWith('??') || !paths.has(r.slice(3)));
        return reply('');
      }
      if (verb === 'clean') {
        const paths = literalPaths(args);
        if (opts.discardIsNoop !== true) drop((r) => !r.startsWith('??') || !paths.has(r.slice(3)));
        return reply('');
      }
      return opts.inner?.run(cwd, args, runOpts) ?? reply('');
    },
  };
  return { runner, lines, calls };
};
