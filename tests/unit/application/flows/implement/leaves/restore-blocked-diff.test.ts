import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  buildEvaluatorReproductionSection,
  REPRODUCTION_TAMPER_NOTE,
  type ReproductionArtifact,
} from '@src/application/flows/implement/leaves/reproduce.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { decidePriorWork, stampPriorWorkOutcome } from '@src/domain/entity/task-prior-work.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import { createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import {
  restoreBeforeFirstTurn,
  restoreBlockedDiffLeaf,
} from '@src/application/flows/implement/leaves/restore-blocked-diff.ts';

const unwrapOk = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`unwrap failed: ${String(r.error)}`);
  return r.value as T;
};

const SPRINT_ID = 'sprint-x' as SprintId;
// A legacy relaunch: the running task carries no recorded decision, so a listed stash is popped.
const RUNNING = makeInProgressTaskWithRunningAttempt();
const TASK_ID: TaskId = RUNNING.id;
const PROGRESS = absolutePath('/sprints/s/progress.md');

/**
 * Records git argv calls; scripts `stash list --format=%s` to contain `stashed` and lets
 * `stash pop` either succeed or fail per `popFails`. `stashed` entries are given in the shape a
 * caller wants to test — real git never renders the bare message (see the `On <branch>: ` tests
 * below), so callers proving the production shape must supply that prefix themselves.
 *
 * `git status` is the tree probe, and it answers from two scripts: `dirtyBefore` until a pop has
 * run, `dirtyAfter` once one has. Both default to empty (a clean tree). A conflicted pop leaves
 * `UU` entries behind — git half-applies the merge and keeps the stash entry — while a pop git
 * refused can still leave plain ` M` / `??` entries, because it applies part of the stash first.
 */
const fakeGit = (opts?: {
  stashed?: string[];
  popFails?: boolean;
  listFails?: boolean;
  dirtyBefore?: string[];
  dirtyAfter?: string[];
  probeFailsBefore?: boolean;
  probeFailsAfter?: boolean;
  onPop?: () => Promise<void>;
  /** The entry is gone by the pop's own list — someone else popped it in between. */
  vanishBeforePop?: boolean;
}): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = [];
  let popRan = false;
  let lists = 0;
  const runner: GitRunner = {
    async run(_cwd, args) {
      calls.push([...args]);
      if (args[0] === 'stash' && args[1] === 'list') {
        if (opts?.listFails === true) return Result.error(new StorageError({ subCode: 'io', message: 'git broke' }));
        lists += 1;
        const stashed = opts?.vanishBeforePop === true && lists > 1 ? [] : (opts?.stashed ?? []);
        return Result.ok({ stdout: stashed.join('\n'), stderr: '', exitCode: 0 });
      }
      if (args[0] === 'stash' && args[1] === 'pop') {
        popRan = true;
        await opts?.onPop?.();
        if (opts?.popFails === true) return Result.ok({ stdout: '', stderr: 'merge conflict', exitCode: 1 });
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'status') {
        const fails = popRan ? opts?.probeFailsAfter : opts?.probeFailsBefore;
        if (fails === true) return Result.ok({ stdout: '', stderr: 'not a git repo', exitCode: 128 });
        const lines = (popRan ? opts?.dirtyAfter : opts?.dirtyBefore) ?? [];
        return Result.ok({ stdout: lines.join('\n'), stderr: '', exitCode: 0 });
      }
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
};

const didReset = (calls: string[][]): boolean => calls.some((c) => c[0] === 'reset' && c[1] === '--hard');
const didPop = (calls: string[][]): boolean => calls.some((c) => c[0] === 'stash' && c[1] === 'pop');
const probeCount = (calls: string[][]): number => calls.filter((c) => c[0] === 'status').length;

const runningCtx = (task: InProgressTask = RUNNING): ImplementCtx => ({
  sprintId: SPRINT_ID,
  currentTask: task,
  tasks: [task],
});
const ctx = runningCtx();

interface LeafHarness {
  readonly el: ReturnType<typeof restoreBlockedDiffLeaf>;
  /** Every task write, in order. */
  readonly saved: Task[];
  /** Every journal append, in order. */
  readonly journal: string[];
}

const restoreLeaf = (
  runner: GitRunner,
  cwd: AbsolutePath = absolutePath('/repos/main'),
  opts?: { updateFails?: boolean; appendFails?: boolean }
): LeafHarness => {
  const saved: Task[] = [];
  const journal: string[] = [];
  const el = restoreBlockedDiffLeaf(
    {
      gitRunner: runner,
      logger: noopLogger,
      taskRepo: {
        async update(_sprintId, task) {
          if (opts?.updateFails === true)
            return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
          saved.push(task);
          return Result.ok(undefined);
        },
      },
      appendFile: async (_path, text) => {
        if (opts?.appendFails === true) return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
        journal.push(text);
        return Result.ok(undefined);
      },
      journalMutex: createFoldQueue(),
    },
    { cwd, progressFile: PROGRESS },
    TASK_ID
  );
  return { el, saved, journal };
};

describe('restoreBlockedDiffLeaf', () => {
  it('pops the deterministic stash when a prior blocked diff is present, in REAL git\'s "On <branch>: <message>" subject shape', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    // `git stash list --format=%s` never renders the bare message it was pushed with — it always
    // prefixes `On <branch>: ` (or `On (no branch): ` detached). A pre-check doing exact equality
    // against the bare message would NEVER match this real shape and always short-circuit —
    // see `stashEntryMatchesMessage` in `git-stash.ts`.
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(true);
  });

  it('also pops on a bare-message entry (defensive — some runners could surface it verbatim)', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [message] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(true);
  });

  it('does not pop when no matching stash exists (clean-tree retry)', async () => {
    const { runner, calls } = fakeGit({ stashed: ['On main: ralphctl/sprint-x/task-other/blocked-diff'] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(false);
  });

  it('is best-effort — a failed pop still returns ok', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner } = fakeGit({ stashed: [`On main: ${message}`], popFails: true });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
  });

  it('a CONFLICTED pop on a clean tree resets it — the half-applied merge never reaches the next commit', async () => {
    // Regression: a non-zero `git stash pop` was swallowed with 'retry will start from a clean
    // tree', but on a content conflict git has already written the `<<<<<<<`-marked merge into the
    // working tree (and kept the stash entry). Left there, `pre-task-verify` reads it as a red
    // `baseline-broken` baseline — no block is set — and `commit-task`'s `git add -A` commits the
    // conflict markers. The conflict is likely by construction: the stash was pushed against the
    // prior attempt's tree and pops into one forked from a since-advanced sprint branch.
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({
      stashed: [`On main: ${message}`],
      popFails: true,
      dirtyAfter: ['UU src/a.ts', 'UU src/b.ts'],
    });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    // Still best-effort — the attempt proceeds, just from the pre-pop tree.
    expect(out.ok).toBe(true);
    // Probed before the pop and after it, then reset: `reset --hard HEAD` plus the `clean -fd`
    // that also drops the untracked files a `-u` stash restores.
    expect(probeCount(calls)).toBe(2);
    expect(didReset(calls)).toBe(true);
    expect(calls.some((c) => c[0] === 'clean' && c[1] === '-fd')).toBe(true);
  });

  it('a failed pop that still changed a clean tree resets it — git applies part of a stash it reports as refused', async () => {
    // No unmerged path anywhere, yet the tree moved: an untracked-file collision still lands the
    // stash's tracked changes before git gives up. The tree was clean before the pop, so every
    // change the probe sees now is the pop's.
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({
      stashed: [`On main: ${message}`],
      popFails: true,
      dirtyAfter: [' M src/a.ts'],
    });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didReset(calls)).toBe(true);
  });

  it('a failed pop that left the tree clean needs no undo — no reset', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`], popFails: true, dirtyAfter: [] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didReset(calls)).toBe(false);
  });

  it('a failed probe after the pop does not reset — the tree state is unknown', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`], popFails: true, probeFailsAfter: true });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didReset(calls)).toBe(false);
  });

  it('leaves the stash alone when the tree already holds uncommitted work — the undo could not tell that work from the pop', async () => {
    // Work that sits in no stash — changes the operator kept at preflight, a test the reproduce step
    // just wrote — would go down with a `reset --hard` + `clean -fd` if the pop then failed. So a
    // dirty tree is never popped onto: the diff stays recoverable under its message instead.
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({
      stashed: [`On main: ${message}`],
      dirtyBefore: [' M notes.md', '?? scratch.txt'],
      popFails: true,
      dirtyAfter: ['UU src/a.ts', ' M notes.md', '?? scratch.txt'],
    });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didPop(calls)).toBe(false);
    expect(didReset(calls)).toBe(false);
  });

  it('a failed probe before the pop skips the restore — no pop, no reset', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`], probeFailsBefore: true });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didPop(calls)).toBe(false);
    expect(didReset(calls)).toBe(false);
  });

  it('never probes the tree when there is nothing to restore', async () => {
    // The common case stays at one git call — the e2e scripted runners count `status` calls.
    const { runner, calls } = fakeGit({ stashed: [] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls).toStrictEqual([['stash', 'list', '--format=%s']]);
  });

  it('a CLEAN pop never resets — the restored diff is exactly what the retry is meant to build on', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`] });
    const el = restoreLeaf(runner).el;

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didPop(calls)).toBe(true);
    // Only the pre-pop probe runs on the happy path — no post-pop probe, no reset.
    expect(probeCount(calls)).toBe(1);
    expect(didReset(calls)).toBe(false);
  });
});

describe('restoreBeforeFirstTurn', () => {
  it('lets the restore through when no terminal exit is on ctx — a generator turn is guaranteed to follow', () => {
    expect(restoreBeforeFirstTurn({ sprintId: SPRINT_ID })).toBe(true);
  });

  it('keeps the quarantined diff in its stash once pre-task-verify blocked the attempt', () => {
    // The gen-eval loop refuses to enter on a set `lastExit`, so zero turns run and the settled
    // block reads as "no AI work" — a diff popped here would never be quarantined again.
    const blocked: ImplementCtx = {
      sprintId: SPRINT_ID,
      lastExit: { kind: 'self-blocked', reason: 'baseline already red at task start' },
      lastBlockReason: 'baseline already red at task start',
    };
    expect(restoreBeforeFirstTurn(blocked)).toBe(false);
  });
});

describe('restoreBlockedDiffLeaf — the reproduction reused from an earlier launch', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let cwd: AbsolutePath;
  const TEST_PATH = 'tests/unit/foo.test.ts';
  const SAVED_CONTENT = "it('reproduces the crash', () => { throw new Error('boom'); });\n";
  const message = quarantineStashMessage(SPRINT_ID, TASK_ID);

  const artifact: ReproductionArtifact = {
    testPath: TEST_PATH,
    runCommand: 'npx vitest run tests/unit/foo.test.ts',
    observedFailure: 'Error: boom',
    relevantTests: [],
    checksum: createHash('sha256').update(SAVED_CONTENT, 'utf-8').digest('hex'),
  };

  const withArtifact: ImplementCtx = { ...runningCtx(), reproductionArtifact: artifact };

  beforeEach(async () => {
    root = await makeTmpRoot();
    cwd = root.root;
  });

  afterEach(async () => {
    await root.cleanup();
  });

  /** Stands in for the pop bringing the earlier launch's test file back into the tree. */
  const popWrites = (content: string) => async (): Promise<void> => {
    await fs.mkdir(join(String(cwd), 'tests', 'unit'), { recursive: true });
    await fs.writeFile(join(String(cwd), TEST_PATH), content, 'utf8');
  };

  const run = async (git: ReturnType<typeof fakeGit>, before: ImplementCtx = withArtifact): Promise<ImplementCtx> => {
    const out = await restoreLeaf(git.runner, cwd).el.execute(before);
    if (!out.ok) throw new Error(`restore failed: ${out.error.error.message}`);
    return out.value.ctx;
  };

  it('keeps the reproduction when the pop brought its test back unchanged', async () => {
    const git = fakeGit({ stashed: [`On main: ${message}`], onPop: popWrites(SAVED_CONTENT) });

    const after = await run(git);

    expect(didPop(git.calls)).toBe(true);
    expect(after.reproductionArtifact).toStrictEqual(artifact);
  });

  it('keeps the reproduction when the restored diff carries an edit to its test, so the evaluator flags it', async () => {
    // The earlier launch weakened the test and blocked; the pop brings that edit back.
    const git = fakeGit({
      stashed: [`On main: ${message}`],
      onPop: popWrites('it.skip("edited", () => {});\n'),
      dirtyAfter: [`?? ${TEST_PATH}`],
    });

    const after = await run(git);

    expect(after.reproductionArtifact).toStrictEqual(artifact);
    expect(git.calls.at(-1)).toStrictEqual([
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      `:(literal)${TEST_PATH}`,
    ]);
    expect(await buildEvaluatorReproductionSection(cwd, artifact)).toContain(REPRODUCTION_TAMPER_NOTE);
  });

  it('keeps an edited reproduction when the probe of its path fails after a clean pop', async () => {
    const git = fakeGit({
      stashed: [`On main: ${message}`],
      onPop: popWrites('it.skip("edited", () => {});\n'),
      probeFailsAfter: true,
    });

    const after = await run(git);

    expect(after.reproductionArtifact).toStrictEqual(artifact);
  });

  it('drops the reproduction when the restored diff does not bring its test back', async () => {
    const git = fakeGit({ stashed: [`On main: ${message}`] });

    const after = await run(git);

    expect(didPop(git.calls)).toBe(true);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops the reproduction when its test file is still at HEAD after the pop — the restored diff never touched it', async () => {
    // The reproduction added a case to an existing test file, and the popped entry doesn't carry
    // that edit: the file on disk is the committed one.
    await popWrites('describe("existing suite", () => {});\n')();
    const git = fakeGit({ stashed: [`On main: ${message}`] });

    const after = await run(git);

    expect(didPop(git.calls)).toBe(true);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops the reproduction when the pop was skipped and its test file is the committed one', async () => {
    await popWrites('describe("existing suite", () => {});\n')();
    const git = fakeGit({ stashed: [`On main: ${message}`], dirtyBefore: [' M README.md'] });

    const after = await run(git);

    expect(didPop(git.calls)).toBe(false);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops the reproduction when a dirty tree kept the earlier work (and its test) in the stash', async () => {
    const git = fakeGit({ stashed: [`On main: ${message}`], dirtyBefore: ['?? scratch.txt'] });

    const after = await run(git);

    expect(didPop(git.calls)).toBe(false);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops the reproduction when the pop failed and the undo took its test out again', async () => {
    const git = fakeGit({
      stashed: [`On main: ${message}`],
      popFails: true,
      dirtyAfter: ['UU src/a.ts'],
    });

    const after = await run(git);

    expect(didReset(git.calls)).toBe(true);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops the reproduction when the tree probe failed and nothing was popped', async () => {
    const git = fakeGit({ stashed: [`On main: ${message}`], probeFailsBefore: true });

    const after = await run(git);

    expect(after.reproductionArtifact).toBeUndefined();
  });

  it("leaves ctx alone when none of the task's work is quarantined — an edit to the test is the evaluator's to flag", async () => {
    // A later attempt of the same launch: nothing to restore, and the test file is gone from the
    // tree. Clearing the reproduction here would hide that from the evaluator's tamper check.
    const git = fakeGit({ stashed: [] });

    const after = await run(git);

    expect(after).toStrictEqual(withArtifact);
  });

  it('leaves ctx alone when the stash cannot be listed', async () => {
    const git = fakeGit({ listFails: true });

    const after = await run(git);

    expect(after).toStrictEqual(withArtifact);
  });

  it('a restore without a reproduction on ctx writes only the stamped task to ctx', async () => {
    const git = fakeGit({ stashed: [`On main: ${message}`] });

    const after = await run(git, runningCtx());

    expect(didPop(git.calls)).toBe(true);
    expect(after.reproductionArtifact).toBeUndefined();
    expect(after.currentTask?.attempts.at(-1)?.priorWork?.kind).toBe('restored');
  });
});

describe('restoreBlockedDiffLeaf — the operator decision and its recorded outcome', () => {
  const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
  const STAT = { files: 5, insertions: 142, deletions: 38 } as const;
  const listed = [`On main: ${message}`];

  /** A relaunch after an unblock that recorded `choice` — the running attempt of the unblocked task. */
  const decided = (choice: 'continue' | 'fresh'): InProgressTask => {
    const todo = decidePriorWork(
      { ...makeTodoTask(), id: TASK_ID },
      { choice, stashMessage: message, stat: STAT, entries: 1 },
      FIXED_NOW
    );
    const running = startNextAttempt(todo, FIXED_NOW, 'session-1');
    if (!running.ok) throw running.error;
    return running.value;
  };

  const runLeaf = async (
    git: ReturnType<typeof fakeGit>,
    task: InProgressTask,
    opts?: Parameters<typeof restoreLeaf>[2]
  ): Promise<LeafHarness & { after: ImplementCtx }> => {
    const harness = restoreLeaf(git.runner, absolutePath('/repos/main'), opts);
    const out = await harness.el.execute(runningCtx(task));
    if (!out.ok) throw new Error(`restore failed: ${out.error.error.message}`);
    return { ...harness, after: out.value.ctx };
  };

  const priorWorkOf = (task: Task | undefined): unknown => task?.attempts.at(-1)?.priorWork;

  it('fresh: no tree probe, no pop — kept-by-choice is stamped, persisted, journaled and put on ctx', async () => {
    const git = fakeGit({ stashed: listed });

    const { after, saved, journal } = await runLeaf(git, decided('fresh'));

    expect(git.calls).toStrictEqual([['stash', 'list', '--format=%s']]);
    const expected = { kind: 'kept-by-choice', stashMessage: message };
    expect(saved).toHaveLength(1);
    expect(priorWorkOf(saved[0])).toStrictEqual(expected);
    expect(saved[0]?.quarantinedDiff?.nextAttempt).toBe('fresh');
    expect(priorWorkOf(after.currentTask)).toStrictEqual(expected);
    expect(priorWorkOf(after.tasks?.[0])).toStrictEqual(expected);
    expect(journal).toStrictEqual([
      `\n_Task ${RUNNING.name}: quarantined diff kept in git stash by operator choice — attempt 1 starts fresh (message: \`${message}\`)._\n`,
    ]);
  });

  it('continue: persists the restored stamp BEFORE the pop, and the consumed fact is gone', async () => {
    let savedAtPop: readonly Task[] = [];
    const ref: { harness?: LeafHarness } = {};
    const git = fakeGit({
      stashed: listed,
      onPop: async () => {
        savedAtPop = [...(ref.harness?.saved ?? [])];
      },
    });
    const harness = restoreLeaf(git.runner);
    ref.harness = harness;

    const out = await harness.el.execute(runningCtx(decided('continue')));
    if (!out.ok) throw new Error('restore failed');

    const expected = { kind: 'restored', stashMessage: message, stat: STAT };
    expect(savedAtPop.map(priorWorkOf)).toStrictEqual([expected]);
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.quarantinedDiff).toBeUndefined();
    expect(priorWorkOf(out.value.ctx.currentTask)).toStrictEqual(expected);
    expect(out.value.ctx.tasks?.[0]?.quarantinedDiff).toBeUndefined();
    expect(harness.journal[0]).toContain('quarantined diff restored into attempt 1 — the stash entry is consumed');
  });

  it('a failed pop re-stamps not-restored over the pre-stamp and keeps the fact with its stat and decision', async () => {
    const git = fakeGit({ stashed: listed, popFails: true, dirtyAfter: ['UU src/a.ts'] });

    const { after, saved, journal } = await runLeaf(git, decided('continue'));

    expect(saved.map(priorWorkOf)).toStrictEqual([
      { kind: 'restored', stashMessage: message, stat: STAT },
      { kind: 'not-restored', stashMessage: message, reason: 'pop-failed' },
    ]);
    expect(saved[1]?.quarantinedDiff).toMatchObject({ stashMessage: message, stat: STAT, nextAttempt: 'continue' });
    expect(after.currentTask).toStrictEqual(saved[1]);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain(
      'quarantined diff left in git stash — stash pop conflicted and the tree was reset; attempt 1 starts without it'
    );
  });

  it('a failed pop whose tree cannot be checked afterwards is recorded as unverified', async () => {
    const git = fakeGit({ stashed: listed, popFails: true, probeFailsAfter: true });

    const { saved } = await runLeaf(git, decided('continue'));

    expect(priorWorkOf(saved.at(-1))).toMatchObject({ reason: 'pop-failed-tree-unverified' });
  });

  it('a failed pop whose reset failed is recorded as unverified', async () => {
    const runner: GitRunner = {
      async run(cwd, args) {
        if (args[0] === 'reset') return Result.ok({ stdout: '', stderr: 'index.lock exists', exitCode: 128 });
        return base.runner.run(cwd, args);
      },
    };
    const base = fakeGit({ stashed: listed, popFails: true, dirtyAfter: ['UU src/a.ts'] });

    const { saved } = await runLeaf({ runner, calls: base.calls }, decided('continue'));

    expect(priorWorkOf(saved.at(-1))).toMatchObject({ reason: 'pop-failed-tree-unverified' });
  });

  it('a dirty tree records how many uncommitted changes kept the diff out, without a pre-stamp', async () => {
    const git = fakeGit({ stashed: listed, dirtyBefore: [' M a.ts', '?? b.ts', '?? c.ts'] });

    const { saved, journal } = await runLeaf(git, decided('continue'));

    expect(didPop(git.calls)).toBe(false);
    expect(saved.map(priorWorkOf)).toStrictEqual([
      { kind: 'not-restored', stashMessage: message, reason: 'dirty-tree', uncommittedPaths: 3 },
    ]);
    expect(journal[0]).toContain('tree had 3 uncommitted changes; attempt 1 starts without it');
  });

  it('a failed tree probe is recorded as such', async () => {
    const git = fakeGit({ stashed: listed, probeFailsBefore: true });

    const { saved } = await runLeaf(git, decided('continue'));

    expect(priorWorkOf(saved[0])).toStrictEqual({
      kind: 'not-restored',
      stashMessage: message,
      reason: 'tree-probe-failed',
    });
  });

  it('a stash-list failure is recorded when the task has a quarantine fact', async () => {
    const git = fakeGit({ listFails: true });

    const { saved, journal } = await runLeaf(git, decided('fresh'));

    expect(priorWorkOf(saved[0])).toStrictEqual({
      kind: 'not-restored',
      stashMessage: message,
      reason: 'stash-list-failed',
    });
    expect(journal[0]).toContain('git stash list failed');
  });

  it('a stash-list failure writes nothing when there is no fact — most tasks never blocked', async () => {
    const git = fakeGit({ listFails: true });

    const { after, saved, journal } = await runLeaf(git, RUNNING);

    expect(saved).toStrictEqual([]);
    expect(journal).toStrictEqual([]);
    expect(after).toStrictEqual(runningCtx());
  });

  it('a legacy listed stash with no fact stamps the outcome and records the pointer it found', async () => {
    const git = fakeGit({ stashed: listed, dirtyBefore: [' M a.ts'] });

    const { saved } = await runLeaf(git, RUNNING);

    expect(saved[0]?.quarantinedDiff).toStrictEqual({ stashMessage: message });
    expect(priorWorkOf(saved[0])).toMatchObject({ kind: 'not-restored', reason: 'dirty-tree' });
  });

  it('clears a stale fact when the stash no longer lists its key — no stamp, no journal line', async () => {
    const git = fakeGit({ stashed: [] });

    const { after, saved, journal } = await runLeaf(git, decided('continue'));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.quarantinedDiff).toBeUndefined();
    expect(priorWorkOf(saved[0])).toBeUndefined();
    expect(after.currentTask?.quarantinedDiff).toBeUndefined();
    expect(after.tasks?.[0]?.quarantinedDiff).toBeUndefined();
    expect(journal).toStrictEqual([]);
  });

  it('an entry popped by someone else between the list and the pop undoes the pre-stamp and clears the fact', async () => {
    const git = fakeGit({ stashed: listed, vanishBeforePop: true });

    const { after, saved, journal } = await runLeaf(git, decided('continue'));

    expect(saved).toHaveLength(2);
    expect(priorWorkOf(saved[1])).toBeUndefined();
    expect(saved[1]?.quarantinedDiff).toBeUndefined();
    expect(after.currentTask).toStrictEqual(saved[1]);
    expect(journal).toStrictEqual([]);
  });

  it('a failed outcome write is logged, and the outcome still reaches the journal and ctx', async () => {
    const git = fakeGit({ stashed: listed });

    const { after, saved, journal } = await runLeaf(git, decided('fresh'), { updateFails: true });

    expect(saved).toStrictEqual([]);
    expect(journal).toHaveLength(1);
    expect(priorWorkOf(after.currentTask)).toMatchObject({ kind: 'kept-by-choice' });
  });

  it('a failed journal append does not fail the leaf', async () => {
    const git = fakeGit({ stashed: listed });

    const { saved } = await runLeaf(git, decided('continue'), { appendFails: true });

    expect(priorWorkOf(saved[0])).toMatchObject({ kind: 'restored' });
  });

  /** The decided task on its second attempt, the first settled as a retry carrying `first`. */
  const secondAttemptAfter = (choice: 'continue' | 'fresh', first: PriorWorkOutcome): InProgressTask => {
    const one = unwrapOk(stampPriorWorkOutcome(decided(choice), first));
    const settled = unwrapOk(failCurrentAttempt(one, FIXED_NOW, 'failed')) as InProgressTask;
    return unwrapOk(startNextAttempt(settled, FIXED_NOW, 'session-2'));
  };

  it('a repeated fresh start is stamped on every attempt but journaled only once', async () => {
    const task = secondAttemptAfter('fresh', { kind: 'kept-by-choice', stashMessage: message });

    const { after, saved, journal } = await runLeaf(fakeGit({ stashed: listed }), task);

    expect(priorWorkOf(saved[0])).toStrictEqual({ kind: 'kept-by-choice', stashMessage: message });
    expect(priorWorkOf(after.currentTask)).toMatchObject({ kind: 'kept-by-choice' });
    expect(journal).toStrictEqual([]);
  });

  it('a repeated not-restored reason is not journaled again, even when the dirty count moved', async () => {
    const task = secondAttemptAfter('continue', {
      kind: 'not-restored',
      stashMessage: message,
      reason: 'dirty-tree',
      uncommittedPaths: 1,
    });

    const { saved, journal } = await runLeaf(fakeGit({ stashed: listed, dirtyBefore: [' M a.ts', '?? b.ts'] }), task);

    expect(priorWorkOf(saved.at(-1))).toMatchObject({ reason: 'dirty-tree', uncommittedPaths: 2 });
    expect(journal).toStrictEqual([]);
  });

  it('an outcome that differs from the previous attempt is journaled', async () => {
    const task = secondAttemptAfter('continue', {
      kind: 'not-restored',
      stashMessage: message,
      reason: 'dirty-tree',
      uncommittedPaths: 1,
    });

    const { journal } = await runLeaf(fakeGit({ stashed: listed }), task);

    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('quarantined diff restored into attempt 2');
  });

  it('fails the trace entry when ctx.currentTask is not the running task — a ctx-shape bug', async () => {
    const out = await restoreLeaf(fakeGit({ stashed: listed }).runner).el.execute({ sprintId: SPRINT_ID });

    expect(out.ok).toBe(false);
  });
});
