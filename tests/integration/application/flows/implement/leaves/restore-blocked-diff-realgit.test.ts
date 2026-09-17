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
 * The remaining cases cover the other half of the leaf's contract against the same real repo: a pop
 * that FAILS. Everything that undo rests on is git semantics a scripted fake cannot establish —
 * that a conflicted pop half-applies the merge into the tree, that a pop git reports as refused can
 * still apply part of the stash, that the stash entry survives either way, that `reset --hard HEAD`
 * + `clean -fd` clears it — and that a tree which already held uncommitted work is never popped
 * onto, since that undo could not tell the two apart.
 */

import { createHash } from 'node:crypto';
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
import {
  buildEvaluatorReproductionSection,
  REPRODUCTION_TAMPER_NOTE,
  type ReproductionArtifact,
} from '@src/application/flows/implement/leaves/reproduce.ts';
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

/**
 * Quarantine a diff to `conflict.ts` under the task's message, then advance the SAME line on the
 * branch — so popping the stash conflicts, the way production hits it (the diff was stashed against
 * the prior attempt's tree and pops into one whose branch has since moved).
 */
const arrangeConflictingStash = async (project: FakeProject, cwd: AbsolutePath, message: string): Promise<void> => {
  await project.writeFile('conflict.ts', 'export const value = "base";\n');
  await project.git('add', '-A');
  await project.git('commit', '-q', '-m', 'feat: base');

  await project.writeFile('conflict.ts', 'export const value = "attempt";\n');
  const pushed = await gitStashPush(createGitRunner(), cwd, message);
  if (!pushed.ok || !pushed.value.stashed) throw new Error('test setup: quarantine push failed');

  await project.writeFile('conflict.ts', 'export const value = "advanced";\n');
  await project.git('add', '-A');
  await project.git('commit', '-q', '-m', 'feat: advance the same line');
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

    // ── Restore: the leaf runs in a retry attempt, before its first generator turn, against the SAME
    // cwd + task.
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
    //  1. a content-conflicting `git stash pop` half-applies the merge and exits non-zero, leaving
    //     changes in a tree that was clean a moment earlier — which is what the post-pop probe sees;
    //  2. git KEEPS the stash entry on that conflict — which is what makes the reset non-destructive;
    //  3. `reset --hard HEAD` + `clean -fd` really does clear the `<<<<<<<` markers.
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const a = blockedTaskA('verify failed: conflict.ts breaks the build');
    const message = quarantineStashMessage(sprintId, a.id);
    const ctx: ImplementCtx = { sprintId, tasks: [a] };
    await arrangeConflictingStash(project, cwd, message);

    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    // Best-effort as ever — the attempt proceeds, just from the pre-pop tree.
    expect(restored.ok).toBe(true);

    // No conflict markers survive for the generator to build on or for `commit-task`'s `git add -A`
    // to absorb into a commit.
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

  it('never pops onto a tree that already holds uncommitted work — that work survives a pop that would have conflicted', async () => {
    // The undo is `reset --hard HEAD` + `clean -fd`, which cannot tell the pop's half-merge from
    // work that was already in the tree and sits in no stash — changes the operator kept at the
    // preflight prompt, or the test the reproduce step writes before the first attempt. Popping
    // here would conflict, and the reset would take both with it.
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const a = blockedTaskA('verify failed: conflict.ts breaks the build');
    const message = quarantineStashMessage(sprintId, a.id);
    const ctx: ImplementCtx = { sprintId, tasks: [a] };
    await arrangeConflictingStash(project, cwd, message);

    const keptEdit = '# fake-project\n\nAn edit the operator kept at preflight.\n';
    const keptFile = 'repro.test.ts — written before the attempt, in no stash\n';
    await project.writeFile('README.md', keptEdit);
    await project.writeFile('repro.test.ts', keptFile);

    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    expect(restored.ok).toBe(true);

    expect(await project.readFile('README.md')).toBe(keptEdit);
    expect(await project.readFile('repro.test.ts')).toBe(keptFile);
    expect(await project.readFile('conflict.ts')).toBe('export const value = "advanced";\n');
    const status = await gitStatusPorcelain(gitRunner, cwd);
    expect(status.ok && status.value.map((e) => e.path).sort()).toStrictEqual(['README.md', 'repro.test.ts']);
    // The diff is where the operator can find it, under its own message.
    expect(await project.git('stash', 'list', '--format=%s')).toContain(message);
  });

  it('sees untracked work even when the repo hides untracked files from `git status`', async () => {
    // `status.showUntrackedFiles=no` makes a plain `git status --porcelain` report a tree holding
    // only untracked files as clean — and `clean -fd` would then delete them after a conflict.
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const a = blockedTaskA('verify failed: conflict.ts breaks the build');
    const message = quarantineStashMessage(sprintId, a.id);
    const ctx: ImplementCtx = { sprintId, tasks: [a] };
    await arrangeConflictingStash(project, cwd, message);
    await project.git('config', 'status.showUntrackedFiles', 'no');

    const keptFile = 'untracked work the operator kept\n';
    await project.writeFile('kept-notes.md', keptFile);

    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    expect(restored.ok).toBe(true);

    expect(await project.readFile('kept-notes.md')).toBe(keptFile);
    expect(await project.readFile('conflict.ts')).toBe('export const value = "advanced";\n');
    expect(await project.git('stash', 'list', '--format=%s')).toContain(message);
  });

  it('undoes a pop git reports as refused when it still applied part of the stash to a clean tree', async () => {
    // No unmerged path is left behind here, yet the tree moved: git lands the stash's tracked change,
    // then fails restoring an untracked file whose path is ignored and occupied by now. Left alone,
    // the attempt would build on — and commit — half of the prior diff.
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const a = blockedTaskA();
    const message = quarantineStashMessage(sprintId, a.id);
    const ctx: ImplementCtx = { sprintId, tasks: [a] };

    await project.writeFile('README.md', '# fake-project\n\nAn edit from the prior attempt.\n');
    await project.writeFile('out/generated.txt', 'stashed while out/ was still tracked-eligible\n');
    const pushed = await gitStashPush(gitRunner, cwd, message);
    expect(pushed.ok && pushed.value.stashed).toBe(true);

    await project.writeFile('.gitignore', 'node_modules/\n.DS_Store\nout/\n');
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'chore: ignore out/');
    const buildOutput = 'a build product that is ignored now\n';
    await project.writeFile('out/generated.txt', buildOutput);
    const readmeAtHead = await project.readFile('README.md');
    const cleanBefore = await gitStatusPorcelain(gitRunner, cwd);
    expect(cleanBefore.ok && cleanBefore.value).toStrictEqual([]);

    const restored = await restoreBlockedDiffLeaf({ gitRunner, logger: noopLogger }, { cwd }, a.id).execute(ctx);
    expect(restored.ok).toBe(true);

    expect(await project.readFile('README.md')).toBe(readmeAtHead);
    const status = await gitStatusPorcelain(gitRunner, cwd);
    expect(status.ok && status.value).toStrictEqual([]);
    // Ignored paths are outside the undo's reach — the build product is untouched.
    expect(await project.readFile('out/generated.txt')).toBe(buildOutput);
    expect(await project.git('stash', 'list', '--format=%s')).toContain(message);
  });
});

/**
 * The reproduction a relaunch reuses: the reproduce leaf adopted it from an earlier launch, and its
 * test only reaches the tree through the pop. Which copy of the test ends up on disk after the pop
 * settles — the restored one, the committed one, or none — is git's doing, so these run for real.
 */
describe('restore-blocked-diff — the reproduction a relaunch reuses (real git)', () => {
  let project: FakeProject;
  const TEST_PATH = 'tests/crash.test.ts';
  const EXISTING_SUITE = "describe('crash', () => {});\n";
  const VALIDATED = `${EXISTING_SUITE}it('reproduces the crash', () => { throw new Error('boom'); });\n`;
  const WEAKENED = `${EXISTING_SUITE}it.skip('reproduces the crash', () => { throw new Error('boom'); });\n`;

  const artifact: ReproductionArtifact = {
    testPath: TEST_PATH,
    runCommand: `npx vitest run ${TEST_PATH}`,
    observedFailure: 'Error: boom',
    relevantTests: [],
    checksum: createHash('sha256').update(VALIDATED, 'utf-8').digest('hex'),
  };

  beforeEach(async () => {
    project = await createFakeProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  /** Quarantine whatever the tree holds right now under task A's key. */
  const quarantine = async (cwd: AbsolutePath, message: string): Promise<void> => {
    const pushed = await gitStashPush(createGitRunner(), cwd, message);
    if (!pushed.ok || !pushed.value.stashed) throw new Error('test setup: quarantine push failed');
  };

  const restore = async (cwd: AbsolutePath, a: BlockedTask): Promise<ImplementCtx> => {
    const ctx: ImplementCtx = { sprintId, tasks: [a], reproductionArtifact: artifact };
    const out = await restoreBlockedDiffLeaf(
      { gitRunner: createGitRunner(), logger: noopLogger },
      { cwd },
      a.id
    ).execute(ctx);
    if (!out.ok) throw new Error(`restore failed: ${out.error.error.message}`);
    return out.value.ctx;
  };

  it('keeps it when the restored diff carries a weakened copy of a new test file — the evaluator gets the tamper note', async () => {
    const cwd = abs(project.path);
    const a = blockedTaskA();
    await project.writeFile(TEST_PATH, WEAKENED);
    await project.writeFile('src/fix.ts', 'export const fixed = false;\n');
    await quarantine(cwd, quarantineStashMessage(sprintId, a.id));

    const after = await restore(cwd, a);

    expect(await project.readFile(TEST_PATH)).toBe(WEAKENED);
    expect(after.reproductionArtifact).toStrictEqual(artifact);
    expect(await buildEvaluatorReproductionSection(cwd, artifact)).toContain(REPRODUCTION_TAMPER_NOTE);
  });

  it('keeps it when the restored diff weakened the case the reproduction added to a committed test file', async () => {
    const cwd = abs(project.path);
    const a = blockedTaskA();
    await project.writeFile(TEST_PATH, EXISTING_SUITE);
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'test: existing suite');
    await project.writeFile(TEST_PATH, WEAKENED);
    await quarantine(cwd, quarantineStashMessage(sprintId, a.id));

    const after = await restore(cwd, a);

    expect(await project.readFile(TEST_PATH)).toBe(WEAKENED);
    expect(after.reproductionArtifact).toStrictEqual(artifact);
  });

  it('drops it when the restored diff does not carry its test', async () => {
    const cwd = abs(project.path);
    const a = blockedTaskA();
    await project.writeFile('src/fix.ts', 'export const fixed = false;\n');
    await quarantine(cwd, quarantineStashMessage(sprintId, a.id));

    const after = await restore(cwd, a);

    expect(await project.readFile('src/fix.ts')).toBe('export const fixed = false;\n');
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops it when the restored diff leaves a committed test file without the added case', async () => {
    // An older entry under the same key still holds the reproduction; the one popped here doesn't.
    const cwd = abs(project.path);
    const a = blockedTaskA();
    await project.writeFile(TEST_PATH, EXISTING_SUITE);
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'test: existing suite');
    await project.writeFile('src/fix.ts', 'export const fixed = false;\n');
    await quarantine(cwd, quarantineStashMessage(sprintId, a.id));

    const after = await restore(cwd, a);

    expect(await project.readFile(TEST_PATH)).toBe(EXISTING_SUITE);
    expect(after.reproductionArtifact).toBeUndefined();
  });

  it('drops it when a dirty tree keeps the quarantined diff in the stash and the test file is the committed one', async () => {
    const cwd = abs(project.path);
    const a = blockedTaskA();
    const message = quarantineStashMessage(sprintId, a.id);
    await project.writeFile(TEST_PATH, EXISTING_SUITE);
    await project.git('add', '-A');
    await project.git('commit', '-q', '-m', 'test: existing suite');
    await project.writeFile(TEST_PATH, VALIDATED);
    await quarantine(cwd, message);
    await project.writeFile('README.md', '# fake-project\n\nAn edit the operator kept at preflight.\n');

    const after = await restore(cwd, a);

    expect(await project.readFile(TEST_PATH)).toBe(EXISTING_SUITE);
    expect(await project.git('stash', 'list', '--format=%s')).toContain(message);
    expect(after.reproductionArtifact).toBeUndefined();
  });
});
