/**
 * Real-git integration test for the quarantine → restore round trip.
 *
 * The bug (code-verified — see `restore-blocked-diff.ts`): the leaf's existence pre-check ran
 * `stashes.value.includes(message)` — exact `Array.prototype.includes` equality against the bare
 * quarantine message. Real git NEVER renders a stash subject as the bare message: `git stash list
 * --format=%s` prints `On <branch>: <message>` (confirmed against a real repo below). So the
 * pre-check always missed and short-circuited to a no-op — `gitStashPop` (which already matched
 * tolerantly) was never reached, and a previously-quarantined diff was never resurrected on retry.
 * Only the unit test's fake (which scripted the bare message directly) was green; against real git
 * the leaf was a permanent no-op.
 *
 * This test drives BOTH sides of the round trip against a real repo, at the same leaf-level seam
 * `quarantine-blocked-diff-realgit.test.ts` uses for the capture half: quarantine a dirty diff,
 * assert the tree is clean, then restore it and assert the SAME content is back — with the stash
 * consumed (popped, not merely inspected).
 *
 * The second case covers the other half of the leaf's contract against the same real repo: a pop
 * that CONFLICTS. Everything that undo rests on is git semantics a scripted fake cannot establish —
 * that a conflicted pop half-applies the merge into the tree, that `--diff-filter=U` is what names
 * it, that the stash entry survives, and that `reset --hard HEAD` + `clean -fd` clears it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitStashPush, gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  quarantineBlockedDiffLeaf,
  quarantineStashMessage,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { restoreBlockedDiffLeaf } from '@src/application/flows/implement/leaves/restore-blocked-diff.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { absolutePath, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const sprintId = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const blockedTaskA = (reason = 'verify failed: a-rejected.ts breaks 2 tests'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask({ name: 'task-A' }), reason, 'own');
  if (!r.ok) throw r.error;
  return r.value;
};

const captureRepo = (): UpdateTask & { saved: () => Task | undefined } => {
  let saved: Task | undefined;
  return {
    saved: () => saved,
    async update(_sprintId, task) {
      saved = task;
      return Result.ok(undefined);
    },
  };
};

describe('restore-blocked-diff — real git round trip with quarantine', () => {
  let project: FakeProject;

  beforeEach(async () => {
    project = await createFakeProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('resurrects a quarantined diff: real git renders the stash subject as "On <branch>: <message>", not the bare message', async () => {
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const repo = captureRepo();
    const a = blockedTaskA();
    const rejectedContent = 'export const broken = true; // rejected by eval\n';

    // ── Capture: task A self-blocked with a rejected (untracked) diff in the tree.
    await project.writeFile('a-rejected.ts', rejectedContent);
    const dirtyBefore = await gitStatusPorcelain(gitRunner, cwd);
    expect(dirtyBefore.ok && dirtyBefore.value.length).toBeGreaterThan(0);

    const journalAppends: string[] = [];
    const ctx: ImplementCtx = { sprintId, tasks: [a] };
    const quarantined = await quarantineBlockedDiffLeaf(
      {
        gitRunner,
        taskRepo: repo,
        appendFile: async (_path, text) => {
          journalAppends.push(text);
          return Result.ok(undefined);
        },
        logger: noopLogger,
      },
      { cwd, progressFile: absolutePath('/tmp/restore-round-trip-progress.md') },
      a.id
    ).execute(ctx);
    expect(quarantined.ok).toBe(true);

    // The tree is clean and the stash exists, verbatim in real git's `On <branch>: ` shape (never
    // the bare message) — pin the exact shape this test exists to prove.
    const cleanAfterQuarantine = await gitStatusPorcelain(gitRunner, cwd);
    expect(cleanAfterQuarantine.ok && cleanAfterQuarantine.value).toStrictEqual([]);
    const message = quarantineStashMessage(sprintId, a.id);
    const stashListRaw = await project.git('stash', 'list', '--format=%s');
    expect(stashListRaw.trim()).toMatch(/^On \S+: /);
    expect(stashListRaw).toContain(message);
    expect(stashListRaw).not.toBe(message); // never the bare message — the whole point of the fix

    // ── Restore: the leaf runs at the start of a retry attempt, against the SAME cwd + task.
    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    expect(restored.ok).toBe(true);

    // The rejected diff is back in the tree, byte-for-byte.
    const dirtyAfterRestore = await gitStatusPorcelain(gitRunner, cwd);
    expect(dirtyAfterRestore.ok && dirtyAfterRestore.value.length).toBeGreaterThan(0);
    const restoredContent = await project.readFile('a-rejected.ts');
    expect(restoredContent).toBe(rejectedContent);

    // The stash was POPPED (consumed), not merely inspected — an empty stash list proves the pop
    // actually ran rather than the pre-check silently no-op-ing the way it did before the fix.
    const stashListAfterRestore = await project.git('stash', 'list');
    expect(stashListAfterRestore.trim()).toBe('');
  });

  it('a CONFLICTED pop leaves no markers in the tree — real git keeps the entry and the reset clears the half-merge', async () => {
    // The undo path's three load-bearing git semantics, none of which a scripted fake can prove:
    //  1. a content-conflicting `git stash pop` half-applies the merge and exits non-zero, so
    //     `git diff --name-only --diff-filter=U` is what actually names the damage;
    //  2. git KEEPS the stash entry on that conflict — which is what makes the reset non-destructive;
    //  3. `reset --hard HEAD` + `clean -fd` really does clear the `<<<<<<<` markers.
    // The conflict is arranged the way production hits it: the diff was stashed against the prior
    // attempt's tree and pops into one whose branch has since advanced the same line.
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const a = blockedTaskA('verify failed: conflict.ts breaks the build');
    const message = quarantineStashMessage(sprintId, a.id);
    const ctx: ImplementCtx = { sprintId, tasks: [a] };

    await project.writeFile('conflict.ts', 'export const value = "base";\n');
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'feat: base');

    // ── The blocked attempt's rejected diff, quarantined under the deterministic message.
    await project.writeFile('conflict.ts', 'export const value = "attempt";\n');
    const pushed = await gitStashPush(gitRunner, cwd, message);
    expect(pushed.ok && pushed.value.stashed).toBe(true);

    // ── The branch advanced the SAME line while the diff sat in the stash.
    await project.writeFile('conflict.ts', 'export const value = "advanced";\n');
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'feat: advance the same line');

    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    // Best-effort as ever — the attempt proceeds, just from the pre-pop tree.
    expect(restored.ok).toBe(true);

    // No conflict markers survive for `pre-task-verify` to read as a broken baseline or for
    // `commit-task`'s `git add -A` to absorb into a commit.
    const content = await project.readFile('conflict.ts');
    expect(content).not.toContain('<<<<<<<');
    expect(content).toBe('export const value = "advanced";\n');
    const status = await gitStatusPorcelain(gitRunner, cwd);
    expect(status.ok && status.value).toStrictEqual([]);

    // …and the rejected diff is still recoverable by hand: git kept the entry on the conflict, and
    // the reset never touched it.
    const stashList = await project.git('stash', 'list', '--format=%s');
    expect(stashList).toContain(message);
  });
});
