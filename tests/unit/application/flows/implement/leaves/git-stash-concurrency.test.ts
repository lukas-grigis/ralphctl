/**
 * Regression coverage for the positional stash-pop race that both `quarantine-blocked-diff.ts`
 * and `restore-blocked-diff.ts` (this directory) sit on top of: `gitStashPop` (in
 * `@src/integration/io/git-operations.ts`, shared by both leaves) used to LIST the stash stack,
 * then act on the matched entry's POSITION in a SEPARATE git invocation. On the parallel implement
 * path several worktree branches push / list / pop concurrently against the ONE `refs/stash` a
 * repo and every one of its worktrees share — a sibling's push landing between the list and the
 * pop shifts every later index by one, so a stale index can name a DIFFERENT (sibling's) entry:
 * applying the wrong diff into the wrong worktree, then dropping the sibling's still-unapplied one.
 *
 * This test forces that exact interleaving deterministically (a controllable "gate" the fake
 * runner awaits mid-`stash list`, so a concurrently-invoked `gitStashPush` gets a window to run
 * before the list call returns) rather than hoping a real race fires under load. `gitStashPop` and
 * `gitStashPush` now serialise through one in-process mutex (`git-operations.ts`), so the
 * concurrently-invoked push cannot even START its own git calls until the pop's list-then-pop
 * critical section has fully settled — without that mutex, the push's calls land inside the gate
 * window and corrupt the result, which is exactly what the "before the fix" run below reproduces.
 */
import { describe, expect, it } from 'vitest';
import { gitStashPop, gitStashPush } from '@src/integration/io/git-operations.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import { Result } from '@src/domain/result.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';

const MESSAGE_A = 'ralphctl/s1/task-a/blocked-diff';
const MESSAGE_B = 'ralphctl/s1/task-b/blocked-diff';

/**
 * A fake `refs/stash` shared by every caller (mirrors real git: one stash ref per repo, shared by
 * all its worktrees) with a gate the test controls to force a specific interleaving of concurrent
 * calls. `stash list` captures its snapshot the instant it's called (matching real git — the read
 * reflects the stack at invocation time) but does not RETURN it until the gate resolves, opening a
 * window for a concurrently-invoked push to mutate the real stack before the caller acts on a now
 * possibly-stale index.
 */
const fakeGitWithGate = (
  initialStack: readonly string[],
  gate: Promise<void>
): { runner: GitRunner; stack: () => readonly string[]; poppedEntryAtPopTime: () => string | undefined } => {
  const stack = [...initialStack];
  let poppedEntryAtPopTime: string | undefined;
  const ok = (stdout = ''): Result<GitRunResult, never> => Result.ok({ stdout, stderr: '', exitCode: 0 }) as never;

  const runner: GitRunner = {
    async run(_cwd, args) {
      const [a, b] = args;
      if (a === 'status') return ok(' M dirty\n'); // always dirty → gitStashPush always proceeds
      if (a === 'stash' && b === 'list') {
        const snapshot = stack.map((m) => `On main: ${m}`).join('\n');
        await gate;
        return ok(snapshot);
      }
      if (a === 'stash' && b === 'push') {
        const msgIdx = args.indexOf('-m');
        const message = args[msgIdx + 1];
        if (message !== undefined) stack.unshift(message); // real git prepends — stash@{0} = newest
        return ok();
      }
      if (a === 'stash' && b === 'pop') {
        const match = /stash@\{(\d+)\}/.exec(args[2] ?? '');
        const idx = match ? Number(match[1]) : -1;
        poppedEntryAtPopTime = idx >= 0 ? stack[idx] : undefined;
        if (idx >= 0) stack.splice(idx, 1);
        return ok();
      }
      return ok();
    },
  };
  return { runner, stack: () => stack, poppedEntryAtPopTime: () => poppedEntryAtPopTime };
};

describe('gitStashPop / gitStashPush — concurrency safety', () => {
  it('a sibling push racing between list and pop never applies the wrong entry — the mutex serialises them', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { runner, stack, poppedEntryAtPopTime } = fakeGitWithGate([MESSAGE_A], gate);
    const cwd = absolutePath('/repos/main');

    // Pop task A's stash — its internal `stash list` call is now suspended on the gate.
    const popPromise = gitStashPop(runner, cwd, MESSAGE_A);
    // Give the pop's `list` call a tick to actually start (and hit the gate) before firing the
    // concurrent push.
    await Promise.resolve();
    await Promise.resolve();

    // A SIBLING branch quarantines a DIFFERENT task's diff concurrently. Without the mutex this
    // push's OWN `status` + `stash push` calls would land here, inside the race window.
    const pushPromise = gitStashPush(runner, cwd, MESSAGE_B);
    // Give the push several ticks to run to completion — enough for it to fully land if nothing is
    // serialising it against the in-flight pop.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    releaseGate();
    const [popped, pushed] = await Promise.all([popPromise, pushPromise]);

    expect(popped.ok).toBe(true);
    expect(pushed.ok).toBe(true);
    if (!popped.ok || !pushed.ok) return;

    expect(popped.value.popped).toBe(true);
    expect(pushed.value.stashed).toBe(true);

    // THE central assertion: the pop applied task A's own diff — never the sibling's, no matter
    // what landed in between the list and the pop. A pre-mutex `gitStashPop` would instead pop
    // whatever the stack's index-0 STILL is by the time `stash pop stash@{0}` actually runs — the
    // sibling's freshly-pushed entry — corrupting task A's worktree with task B's diff.
    expect(poppedEntryAtPopTime()).toBe(MESSAGE_A);

    // Task B's stash survives, untouched, for its own restore later — the sibling's diff is not
    // silently dropped as collateral damage of the mis-pop.
    expect(stack()).toStrictEqual([MESSAGE_B]);
  });
});
