import { describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  gitDeleteBranch,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
} from '@src/integration/io/git-operations.ts';
import { gitWorktreeList } from '@src/integration/io/git-worktree-list.ts';
import { gitRenameBranch } from '@src/integration/io/git-ref-rescue.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { okGit } from '@tests/fixtures/git-result.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

/** A runner that yields a few ticks per call and records the peak number of calls in flight per cwd. */
const overlapProbe = (): { runner: GitRunner; peak: (cwd: string) => number; peakAll: () => number } => {
  const inFlight = new Map<string, number>();
  const peaks = new Map<string, number>();
  let all = 0;
  let peakAll = 0;
  return {
    runner: {
      async run(cwd) {
        const key = String(cwd);
        const now = (inFlight.get(key) ?? 0) + 1;
        inFlight.set(key, now);
        peaks.set(key, Math.max(peaks.get(key) ?? 0, now));
        all += 1;
        peakAll = Math.max(peakAll, all);
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        all -= 1;
        inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
        return okGit('worktree /repo\nbranch refs/heads/main\n', 0);
      },
    },
    peak: (cwd) => peaks.get(cwd) ?? 0,
    peakAll: () => peakAll,
  };
};

// git dies when a command walks `.git/worktrees/` while a sibling add / remove is half-way through
// writing or deleting an entry (`failed to read .git/worktrees/<x>/commondir`), so these never overlap.
describe('worktree-admin git commands on one repo', () => {
  it('run one at a time, whichever primitive issues them', async () => {
    const { runner, peak } = overlapProbe();
    const repo = abs('/repo');
    await Promise.all([
      gitWorktreeAdd(runner, repo, abs('/repo/wt-a'), 'ref-a'),
      gitWorktreeAdd(runner, repo, abs('/repo/wt-b'), 'ref-b'),
      gitWorktreeList(runner, repo),
      gitWorktreePrune(runner, repo),
      gitWorktreeRemove(runner, repo, abs('/repo/wt-c')),
      gitDeleteBranch(runner, repo, 'ref-c'),
      gitRenameBranch(runner, repo, 'ref-d', 'ref-e'),
    ]);
    expect(peak('/repo')).toBe(1);
  });

  it('still overlap across different repositories', async () => {
    const { runner, peakAll } = overlapProbe();
    await Promise.all([
      gitWorktreeAdd(runner, abs('/repo-1'), abs('/repo-1/wt-a'), 'ref-a'),
      gitWorktreeAdd(runner, abs('/repo-2'), abs('/repo-2/wt-a'), 'ref-a'),
    ]);
    expect(peakAll()).toBe(2);
  });

  it('a failing command does not wedge the ones queued behind it', async () => {
    let calls = 0;
    const runner: GitRunner = {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('spawn exploded');
        return okGit('', 0);
      },
    };
    const repo = abs('/repo');
    const first = gitWorktreePrune(runner, repo);
    const second = gitWorktreePrune(runner, repo);
    await expect(first).rejects.toThrow('spawn exploded');
    expect((await second).ok).toBe(true);
  });
});
