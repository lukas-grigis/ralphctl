import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * In-process FIFO mutex, one queue per repository, for every git command that creates, removes or
 * walks linked worktrees: `worktree add / remove / prune / list` and `branch -D / -m` (git refuses
 * those on a ref checked out in any worktree, so it reads them all). git's worktree bookkeeping is
 * not safe under concurrent use: an add or remove half-way through leaves `.git/worktrees/<name>`
 * without its `commondir` / `locked` / `gitdir` file, and a sibling command walking the entries
 * dies on it (`fatal: failed to read .git/worktrees/<x>/commondir`, verified on git 2.56). The
 * parallel implement path runs every branch's setup and teardown concurrently in one process, so
 * those calls are serialised here. Callers key on the main checkout root they already pass as cwd.
 * Cross-process use stays out of scope — the sprint lock keeps a second run off the repo.
 */
const tails = new Map<string, Promise<unknown>>();
const settled = (): undefined => undefined; // advances the queue on settle, ok OR error

export const withWorktreeMutex = <T>(repoRoot: AbsolutePath, fn: () => Promise<T>): Promise<T> => {
  const key = String(repoRoot);
  const result = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = result.then(settled, settled);
  tails.set(key, tail);
  // Drop the entry once the queue drains so a long-lived process doesn't keep one per repo forever.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
};
