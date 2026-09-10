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
});
