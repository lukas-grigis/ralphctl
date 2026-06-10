import { describe, expect, it, vi } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner, ShellScriptResult } from '@src/integration/io/shell-script-runner.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import {
  buildWorktreeBranch,
  createFoldQueue,
  perBranchSignalSink,
  serializeAppendFile,
  worktreePathFor,
  type BuildWaveBranchesDeps,
} from '@src/application/flows/implement/wave-branch.ts';

import { absolutePath, makeDoneTask, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

// ── createFoldQueue ─────────────────────────────────────────────────────────────────────────

describe('createFoldQueue', () => {
  it('serialises concurrent runs — no two critical sections overlap', async () => {
    const queue = createFoldQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const work = async (): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    };
    await Promise.all([queue.run(work), queue.run(work), queue.run(work), queue.run(work)]);
    expect(maxInFlight).toBe(1);
  });

  it('runs in FIFO enqueue order', async () => {
    const queue = createFoldQueue();
    const order: number[] = [];
    const mk = (n: number) => async (): Promise<void> => {
      await Promise.resolve();
      order.push(n);
    };
    await Promise.all([queue.run(mk(1)), queue.run(mk(2)), queue.run(mk(3))]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a rejecting fn does not wedge the queue — later runs still execute', async () => {
    const queue = createFoldQueue();
    const ran: string[] = [];
    const first = queue.run(async () => {
      throw new Error('boom');
    });
    const second = queue.run(async () => {
      ran.push('second');
    });
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(ran).toEqual(['second']);
  });
});

// ── worktreePathFor ─────────────────────────────────────────────────────────────────────────

describe('worktreePathFor', () => {
  it('roots the worktree under <sprintDir>/worktrees/wt-<taskId>', () => {
    const sprintDir = absolutePath('/data/sprints/s1');
    const task = makeTodoTask();
    expect(String(worktreePathFor(sprintDir, task.id))).toBe(`/data/sprints/s1/worktrees/wt-${String(task.id)}`);
  });
});

// ── branch element (worktree setup / fold / cleanup / conflict) ───────────────────────────────

const ok = (stdout = '', exitCode = 0, stderr = ''): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr, exitCode });

const conflict = (): Result<GitRunResult, StorageError> => ok('CONFLICT (content)', 1, 'cherry-pick failed');

/** A git runner that records argv and replies based on the FIRST arg (worktree/merge/cherry-pick). */
const fakeGit = (over?: {
  foldConflict?: boolean;
  removeFails?: boolean;
}): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      const [a, b] = args;
      if (a === 'worktree' && b === 'remove') return over?.removeFails === true ? conflict() : ok();
      if (a === 'merge' && b === '--ff-only') return over?.foldConflict === true ? ok('not ff', 1) : ok();
      if (a === 'merge-base') return ok('a'.repeat(40));
      if (a === 'cherry-pick') return over?.foldConflict === true ? conflict() : ok();
      return ok(); // worktree add / prune / etc.
    },
  };
  return { runner, calls };
};

const stubBus = (events: AppEvent[]): EventBus => ({
  publish: (e) => events.push(e),
  subscribe: () => () => {},
});

const makeBranchDeps = (
  runner: GitRunner,
  appSignals: HarnessSignalSink,
  eventBus: EventBus,
  shellScriptRunner?: ShellScriptRunner
): BuildWaveBranchesDeps => ({
  implement: {
    gitRunner: runner,
    logger: noopLogger,
    ...(shellScriptRunner !== undefined ? { shellScriptRunner } : {}),
  } as unknown as ImplementDeps,
  appSignals,
  eventBus,
  foldQueue: createFoldQueue(),
});

/** A fake shell-script runner that records (cwd, script) per call and replies with a fixed result. */
const okShell = (passed = true, exitCode = 0): Result<ShellScriptResult, StorageError> =>
  Result.ok({ passed, exitCode, output: '', durationMs: 1 });

const fakeShell = (
  result: Result<ShellScriptResult, StorageError> = okShell()
): { runner: ShellScriptRunner; calls: Array<{ cwd: string; script: string; signal: AbortSignal | undefined }> } => {
  const calls: Array<{ cwd: string; script: string; signal: AbortSignal | undefined }> = [];
  const runner: ShellScriptRunner = {
    async run(cwd, script, opts) {
      calls.push({ cwd: String(cwd), script, signal: opts?.signal });
      return result;
    },
  };
  return { runner, calls };
};

const repo: RepoExecConfig = { path: absolutePath('/repos/main'), name: 'main-repo' };
const repoWithSetup: RepoExecConfig = {
  path: absolutePath('/repos/main'),
  name: 'main-repo',
  setupScript: 'pnpm install',
};

/** A fake subchain that settles the given task into the supplied final copy on ctx.tasks. */
const settlingSubchain = (taskId: TaskId, settled: Task): ((worktreeRepo: RepoExecConfig) => Element<ImplementCtx>) => {
  return (worktreeRepo) => ({
    name: `fake-subchain-${String(taskId)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      // Assert the subchain received the worktree-pointed repo.
      expect(String(worktreeRepo.path)).toContain('worktrees');
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === taskId ? settled : t));
      return Result.ok({ ctx: { ...ctx, tasks }, trace: [] });
    },
  });
};

const runBranch = async (
  element: Element<ImplementCtx>,
  base: ImplementCtx
): Promise<{ status: string; ctx: ImplementCtx }> => {
  const runner = createRunner<ImplementCtx>({ id: 'branch', element, initialCtx: base });
  await runner.start();
  return { status: runner.status, ctx: runner.ctx };
};

const baseCtx = (tasks: readonly Task[]): ImplementCtx => {
  const sprint = makePlannedSprint();
  return { sprintId: sprint.id, sprint, tasks };
};

describe('buildWorktreeBranch — happy path', () => {
  it('sets up the worktree, runs the subchain on the worktree repo, folds the done task, and cleans up', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner, calls } = fakeGit();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ralphctl/s1/wt-x', settlingSubchain(task.id, done));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    expect(ctx.tasks?.find((t) => t.id === task.id)?.status).toBe('done');
    // Worktree add (setup), a ff-only fold, and a forced remove (cleanup) all ran.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true);
    expect(calls.some((c) => c[0] === 'merge' && c[1] === '--ff-only')).toBe(true);
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove' && c[2] === '--force')).toBe(true);
  });

  it('never stashes the main repo', async () => {
    const task = makeTodoTask();
    const { runner, calls } = fakeGit();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ref',
      settlingSubchain(task.id, { ...makeDoneTask(), id: task.id })
    );
    await runBranch(branch, baseCtx([task]));
    expect(calls.some((c) => c[0] === 'stash')).toBe(false);
  });
});

describe('buildWorktreeBranch — fold conflict → blocked', () => {
  it('blocks the task on a cherry-pick conflict and still cleans up; siblings unaffected', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner, calls } = fakeGit({ foldConflict: true });
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ref', settlingSubchain(task.id, done));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    // The branch COMPLETES (a conflict is a domain block, not an infra failure) and its ctx carries
    // the blocked task — so the merge reducer overlays the block (siblings stay landed).
    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');
    // Cleanup ran even on the conflict path.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
  });
});

describe('buildWorktreeBranch — does not fold a non-done task', () => {
  it('skips the fold when the subchain settled the task blocked', async () => {
    const task = makeTodoTask();
    // Subchain leaves the task as-is (todo) — e.g. self-blocked path with no commit.
    const { runner, calls } = fakeGit();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const passthroughSubchain = (): Element<ImplementCtx> => ({
      name: 'passthrough',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        return Result.ok({ ctx, trace: [] });
      },
    });

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ref', passthroughSubchain);
    const { status } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    // No fold (no merge --ff-only) because the task never reached `done`; cleanup still ran.
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
  });
});

// ── per-branch signal sink attribution ────────────────────────────────────────────────────────

describe('perBranchSignalSink — taskId attribution under concurrency', () => {
  const change = (text: string): HarnessSignal => ({ type: 'change', text, timestamp: IsoTimestamp.now() });

  it('stamps each branch sink with ITS OWN taskId — two branches do not cross-attribute', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const events: AppEvent[] = [];
    const bus = stubBus(events);
    const appSeen: HarnessSignal[] = [];
    const appSink: HarnessSignalSink = { emit: (s) => appSeen.push(s) };

    const sink1 = perBranchSignalSink(appSink, bus, t1.id);
    const sink2 = perBranchSignalSink(appSink, bus, t2.id);

    // Interleave emissions to simulate concurrent branches.
    sink1.emit(change('from-1-a'));
    sink2.emit(change('from-2-a'));
    sink1.emit(change('from-1-b'));

    const harness = events.filter((e) => e.type === 'harness-signal');
    expect(harness).toHaveLength(3);
    // Each event carries the taskId of the branch that emitted it — never the other branch's.
    const byText = new Map(harness.map((e) => [e.type === 'harness-signal' ? e.text : '', e]));
    expect(byText.get('from-1-a')).toMatchObject({ taskId: String(t1.id) });
    expect(byText.get('from-1-b')).toMatchObject({ taskId: String(t1.id) });
    expect(byText.get('from-2-a')).toMatchObject({ taskId: String(t2.id) });
    // Every signal also reached the app-wide sink.
    expect(appSeen).toHaveLength(3);
  });

  it('ignores non-text-bearing signal kinds (only change/learning/note mirror to the bus)', () => {
    const t1 = makeTodoTask();
    const events: AppEvent[] = [];
    const sink = perBranchSignalSink({ emit: vi.fn() }, stubBus(events), t1.id);

    sink.emit({ type: 'decision', text: 'a decision', timestamp: IsoTimestamp.now() });
    sink.emit({ type: 'learning', text: 'a learning', timestamp: IsoTimestamp.now() });

    const harness = events.filter((e) => e.type === 'harness-signal');
    expect(harness.map((e) => (e.type === 'harness-signal' ? e.signalKind : ''))).toEqual(['learning']);
  });
});

describe('buildWorktreeBranch — abort runs cleanup', () => {
  it('runs worktree cleanup even when the subchain is aborted mid-flight, and never stashes', async () => {
    const task = makeTodoTask();
    const { runner, calls } = fakeGit();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    // A subchain that hangs until aborted.
    const hangingSubchain = (): Element<ImplementCtx> => ({
      name: 'hang',
      async execute(_ctx, signal): Promise<ElementResult<ImplementCtx>> {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        const error = new AbortError({ elementName: 'hang' });
        return Result.error({ error, trace: [{ elementName: 'hang', status: 'aborted', durationMs: 0, error }] });
      },
    });

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ref', hangingSubchain);
    const r = createRunner<ImplementCtx>({ id: 'b', element: branch, initialCtx: baseCtx([task]) });
    const started = r.start();
    await Promise.resolve();
    await Promise.resolve();
    r.abort();
    await started;

    expect(r.status).toBe('aborted');
    // Cleanup MUST have run despite the abort; no fold (task never settled done); no stash.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
    expect(calls.some((c) => c[0] === 'stash')).toBe(false);
  });
});

// ── per-worktree setup script ─────────────────────────────────────────────────────────────────

describe('buildWorktreeBranch — per-worktree setup script', () => {
  it('runs setupScript IN the worktree cwd before the subchain, then folds the done task', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner, calls } = fakeGit();
    const shell = fakeShell(okShell(true));
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]), shell.runner);
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repoWithSetup, task, wt, 'ref', settlingSubchain(task.id, done));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    expect(ctx.tasks?.find((t) => t.id === task.id)?.status).toBe('done');
    // Setup ran exactly once, in the WORKTREE cwd (not the main repo), with the repo's script.
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.cwd).toContain('worktrees');
    expect(shell.calls[0]!.cwd).not.toBe(String(repo.path));
    expect(shell.calls[0]!.script).toBe('pnpm install');
    // The fold still ran because the task settled `done`.
    expect(calls.some((c) => c[0] === 'merge' && c[1] === '--ff-only')).toBe(true);
  });

  it('threads the chain abort signal into the setup-script runner (prompt Ctrl-C kill, not timeout)', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner } = fakeGit();
    const shell = fakeShell(okShell(true));
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]), shell.runner);
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(deps, repoWithSetup, task, wt, 'ref', settlingSubchain(task.id, done));
    const out = await branch.execute(baseCtx([task]), controller.signal);

    expect(out.ok).toBe(true);
    // The runner received the SAME signal the chain handed the branch — an abort mid-setup kills
    // the child promptly instead of waiting out the shell timeout while the worktree sits locked.
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.signal).toBe(controller.signal);
  });

  it('blocks ONLY this task and skips the subchain when setupScript exits non-zero; cleanup still runs', async () => {
    const task = makeTodoTask();
    const { runner, calls } = fakeGit();
    const shell = fakeShell(okShell(false, 1));
    let bodyRan = false;
    const trackingSubchain = (): Element<ImplementCtx> => ({
      name: 'body',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        bodyRan = true;
        return Result.ok({ ctx, trace: [] });
      },
    });
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]), shell.runner);
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repoWithSetup, task, wt, 'ref', trackingSubchain);
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    // The branch COMPLETES (a setup failure is a per-task domain block, not an infra abort) and its
    // ctx carries ONLY the blocked task, so `mergeImplementWave` overlays the block.
    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');
    expect(bodyRan).toBe(false); // subchain skipped — never ran in an unprepared worktree
    expect(calls.some((c) => c[0] === 'merge')).toBe(false); // no fold for a blocked task
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true); // cleanup ran
  });

  it('blocks the task when setupScript cannot even spawn (Result.error)', async () => {
    const task = makeTodoTask();
    const { runner } = fakeGit();
    const shell = fakeShell(Result.error(new StorageError({ subCode: 'io', message: 'shell binary missing' })));
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]), shell.runner);
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repoWithSetup, task, wt, 'ref', () => ({
      name: 'unreached',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        return Result.ok({ ctx, trace: [] });
      },
    }));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    expect(ctx.tasks?.find((t) => t.id === task.id)?.status).toBe('blocked');
  });

  it('skips setup entirely (no shell call) when the repo configures no setupScript', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner } = fakeGit();
    const shell = fakeShell();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]), shell.runner);
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ref', settlingSubchain(task.id, done));
    const { status } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    expect(shell.calls).toHaveLength(0); // no setupScript → setup step is a no-op
  });
});

// ── defensive branch-ref pre-delete (idempotent relaunch after a crashed run) ──────────────────

describe('setupWorktree — defensive leaked-ref delete before add', () => {
  it('deletes the wt-<task> ref BEFORE `worktree add -b` so a leaked ref never wedges relaunch', async () => {
    const task = makeTodoTask();
    const done: Task = { ...makeDoneTask(), id: task.id };
    const { runner, calls } = fakeGit();
    const deps = makeBranchDeps(runner, { emit: vi.fn() }, stubBus([]));
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ralphctl/s1/wt-x', settlingSubchain(task.id, done));
    await runBranch(branch, baseCtx([task]));

    const firstDeleteIdx = calls.findIndex((c) => c[0] === 'branch' && c[1] === '-D' && c[2] === 'ralphctl/s1/wt-x');
    const addIdx = calls.findIndex((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(firstDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIdx).toBeLessThan(addIdx); // defensive delete precedes the add
  });
});

// ── serializeAppendFile ────────────────────────────────────────────────────────────────────────

describe('serializeAppendFile', () => {
  it('serialises concurrent appends — critical sections never overlap, FIFO order preserved', async () => {
    const completed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    // An inner append that yields twice mid-write — overlapping calls would interleave here.
    const inner: AppendFile = async (_path, text) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      completed.push(text);
      return Result.ok(undefined);
    };
    const append = serializeAppendFile(inner);
    const p = absolutePath('/data/sprints/s1/progress.md');
    await Promise.all([append(p, 'a'), append(p, 'b'), append(p, 'c'), append(p, 'd')]);

    expect(maxInFlight).toBe(1); // never two appends writing at once
    expect(completed).toEqual(['a', 'b', 'c', 'd']); // FIFO enqueue order
  });

  it('a rejecting append does not wedge the serializer — later appends still run', async () => {
    const ran: string[] = [];
    let first = true;
    const inner: AppendFile = async (_path, text) => {
      if (first) {
        first = false;
        throw new Error('disk full');
      }
      ran.push(text);
      return Result.ok(undefined);
    };
    const append = serializeAppendFile(inner);
    const p = absolutePath('/x');
    await expect(append(p, 'boom')).rejects.toThrow('disk full');
    await append(p, 'after');
    expect(ran).toEqual(['after']);
  });
});
