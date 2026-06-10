/**
 * Real-git integration test for the serial dirty-tree contamination fix.
 *
 * The bug (all claims code-verified): on the SERIAL implement path every task runs in ONE shared
 * worktree. A task that settles `blocked` (verify-failed self-block) deliberately leaves its
 * rejected diff in that tree — `settle-attempt`'s dirty-tree guardrail exempts the block path. With
 * nothing cleaning the tree between tasks, the NEXT task's `git add -A` commit swept the prior
 * task's rejected diff into its own commit; the contamination also flipped the next task's
 * pre-verify red and the red post-verify was mis-attributed `baseline-broken`, landing a corrupt
 * commit even on a red tree.
 *
 * This test reproduces the exact sequence against a REAL git repo (no fake runner) at the
 * leaf + commit level — the truthful seam for the contamination claim — rather than standing up the
 * full AI-driven gen-eval serial chain (which would need a faked provider that self-blocks task A
 * then commits clean on task B, plus verify-script stubs: far heavier for the same guarantee). The
 * subchain-level flow-shape fence (`flow-shape.test.ts`) already proves the leaf is spliced into the
 * serial path before the terminal leaf; this proves the leaf's REAL effect on a REAL tree.
 *
 * Justification for the chosen scope (per the task brief): a real-git serial test through the whole
 * implement chain is too heavy for the marginal coverage, so we exercise the quarantine leaf with a
 * real GitRunner against a real repo, then run the real `gitCommitWithMessage` the next task would —
 * and assert task B's commit does NOT contain task A's paths and A's blockedReason names the stash.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import { gitCommitWithMessage, gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  quarantineBlockedDiffLeaf,
  quarantineStashMessage,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
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

// In-memory single-task repo capturing the persisted blockedReason — stands in for tasks.json.
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

describe('quarantine-blocked-diff — real git contamination fence', () => {
  let project: FakeProject;

  beforeEach(async () => {
    project = await createFakeProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('stashes task A’s rejected diff so task B’s commit stays clean, and records the recovery handle', async () => {
    const cwd = abs(project.path);
    const gitRunner = createGitRunner();
    const repo = captureRepo();
    const a = blockedTaskA();

    // ── Reproduce the bug's precondition: task A self-blocked and left its rejected work in the
    // shared tree. `a-rejected.ts` is an UNTRACKED file (the worst case — `-u` must catch it).
    await project.writeFile('a-rejected.ts', 'export const broken = true; // rejected by eval\n');
    // Sanity: the tree is dirty before quarantine.
    const dirtyBefore = await gitStatusPorcelain(gitRunner, cwd);
    expect(dirtyBefore.ok && dirtyBefore.value.length).toBeGreaterThan(0);

    // ── Run the quarantine leaf for the just-blocked task A (the serial-path splice).
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
      { cwd, progressFile: absolutePath('/tmp/quarantine-progress.md') },
      a.id
    ).execute(ctx);
    expect(quarantined.ok).toBe(true);
    if (!quarantined.ok) return;

    // The shared tree is clean again — the invariant the prologue's one-shot preflight assumes.
    const cleanAfter = await gitStatusPorcelain(gitRunner, cwd);
    expect(cleanAfter.ok && cleanAfter.value).toStrictEqual([]);

    // A's blockedReason names the deterministic stash, recoverable via `git stash list`.
    const message = quarantineStashMessage(sprintId, a.id);
    const savedA = repo.saved() as BlockedTask;
    expect(savedA.blockedReason).toContain('verify failed');
    // The recovery pointer is ALSO journaled — blockedReason is stripped by an operator unblock
    // (clean restart), so progress.md is the durable harness artifact naming the stash.
    expect(journalAppends.join('')).toContain('quarantined to git stash');
    expect(savedA.blockedReason).toContain(message);
    expect(savedA.blockedReason).toMatch(/git stash list/);
    const stashList = await project.git('stash', 'list');
    expect(stashList).toContain(message);
    // The rejected (untracked) file was swept into the stash — git tracks untracked-stash content
    // in the stash's third parent, so `stash show --include-untracked` lists it. The file is gone
    // from the working tree (asserted clean above), so it lives ONLY in the stash now.
    const stashFiles = await project.git('stash', 'show', '--include-untracked', '--name-only', 'stash@{0}');
    expect(stashFiles).toContain('a-rejected.ts');

    // ── Task B now writes its OWN change and commits exactly as the next task's commit-task leaf
    // would (real `git add -A` under the hood). This is where the bug used to sweep A's leftovers in.
    await project.writeFile('b-feature.ts', 'export const feature = 42;\n');
    const committed = await gitCommitWithMessage(gitRunner, cwd, 'feat: task B feature');
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.committed).toBe(true);

    // ── The central assertion: task B's commit contains ONLY B's path — A's rejected diff was
    // quarantined, so it cannot have been swept into B's commit.
    const filesInHead = (await project.git('show', '--name-only', '--pretty=format:', 'HEAD'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(filesInHead).toContain('b-feature.ts');
    expect(filesInHead).not.toContain('a-rejected.ts');
  });
});
