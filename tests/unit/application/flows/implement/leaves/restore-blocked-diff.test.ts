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
 * `stash pop` either succeed or fail per `popFails`. `stashed` entries are given in the shape a
 * caller wants to test — real git never renders the bare message (see the `On <branch>: ` tests
 * below), so callers proving the production shape must supply that prefix themselves.
 *
 * `unmerged` scripts the post-pop conflict probe (`git diff --name-only --diff-filter=U`): a
 * non-empty list is what real git leaves behind when a pop CONFLICTS — it half-applies the merge
 * into the working tree and keeps the stash entry. Default empty, i.e. the "git refused before
 * applying anything" shape.
 */
const fakeGit = (opts?: {
  stashed?: string[];
  popFails?: boolean;
  listFails?: boolean;
  unmerged?: string[];
  probeFails?: boolean;
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
      if (args[0] === 'diff' && args[2] === '--diff-filter=U') {
        if (opts?.probeFails === true) return Result.ok({ stdout: '', stderr: 'not a git repo', exitCode: 128 });
        return Result.ok({ stdout: (opts?.unmerged ?? []).join('\n'), stderr: '', exitCode: 0 });
      }
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
};

const didReset = (calls: string[][]): boolean => calls.some((c) => c[0] === 'reset' && c[1] === '--hard');

const ctx: ImplementCtx = { sprintId: SPRINT_ID };

describe('restoreBlockedDiffLeaf', () => {
  it('pops the deterministic stash when a prior blocked diff is present, in REAL git\'s "On <branch>: <message>" subject shape', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    // `git stash list --format=%s` never renders the bare message it was pushed with — it always
    // prefixes `On <branch>: ` (or `On (no branch): ` detached). A pre-check doing exact equality
    // against the bare message would NEVER match this real shape and always short-circuit —
    // see `stashEntryMatchesMessage` in `git-operations.ts`.
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`] });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(true);
  });

  it('also pops on a bare-message entry (defensive — some runners could surface it verbatim)', async () => {
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
    const { runner, calls } = fakeGit({ stashed: ['On main: ralphctl/sprint-x/task-other/blocked-diff'] });
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
    const { runner } = fakeGit({ stashed: [`On main: ${message}`], popFails: true });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
  });

  it('a CONFLICTED pop resets the tree — the half-applied merge never reaches the next commit', async () => {
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
      unmerged: ['src/a.ts', 'src/b.ts'],
    });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    // Still best-effort — the attempt proceeds, just from the pre-pop tree.
    expect(out.ok).toBe(true);
    // The probe ran, then the reset: `reset --hard HEAD` plus the `clean -fd` that also drops the
    // untracked files a `-u` stash restores.
    expect(calls.some((c) => c[0] === 'diff' && c[2] === '--diff-filter=U')).toBe(true);
    expect(didReset(calls)).toBe(true);
    expect(calls.some((c) => c[0] === 'clean' && c[1] === '-fd')).toBe(true);
  });

  it('a pop that failed WITHOUT conflicting leaves the tree alone — no reset', async () => {
    // 'Your local changes would be overwritten' and friends: git refuses before applying anything,
    // so the tree is exactly as this leaf found it. Resetting there would destroy work the leaf
    // never put at risk — hence the unmerged-path gate rather than a blind reset.
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`], popFails: true, unmerged: [] });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didReset(calls)).toBe(false);
  });

  it('a failed conflict probe does not reset either — the tree state is unknown', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`], popFails: true, probeFails: true });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(didReset(calls)).toBe(false);
  });

  it('a CLEAN pop never resets — the restored diff is exactly what the retry is meant to build on', async () => {
    const message = quarantineStashMessage(SPRINT_ID, TASK_ID);
    const { runner, calls } = fakeGit({ stashed: [`On main: ${message}`] });
    const el = restoreBlockedDiffLeaf(
      { gitRunner: runner, logger: noopLogger },
      { cwd: absolutePath('/repos/main') },
      TASK_ID
    );

    const out = await el.execute(ctx);

    expect(out.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'stash' && c[1] === 'pop')).toBe(true);
    // Neither the probe nor the reset runs on the happy path.
    expect(calls.some((c) => c[0] === 'diff')).toBe(false);
    expect(didReset(calls)).toBe(false);
  });
});
