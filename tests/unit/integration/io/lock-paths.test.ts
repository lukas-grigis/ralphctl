import { describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';

const locksRoot = ((): AbsolutePath => {
  const r = AbsolutePath.parse('/var/lib/ralphctl/state/locks');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const wt = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('test setup');
  return r.value;
};

describe('repoLockFile', () => {
  it('builds a repo lock path keyed by worktree-path hash', () => {
    const result = repoLockFile(locksRoot, wt('/Users/me/code/repo-a'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.value)).toMatch(/^\/var\/lib\/ralphctl\/state\/locks\/repo-[0-9a-f]{16}\.lock$/);
    }
  });

  it('produces stable hashes — same path → same lock', () => {
    const a = repoLockFile(locksRoot, wt('/Users/me/code/repo-a'));
    const b = repoLockFile(locksRoot, wt('/Users/me/code/repo-a'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(String(a.value)).toBe(String(b.value));
  });

  it('different worktree paths → different locks', () => {
    const a = repoLockFile(locksRoot, wt('/Users/me/code/repo-a'));
    const b = repoLockFile(locksRoot, wt('/Users/me/code/repo-b'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(String(a.value)).not.toBe(String(b.value));
  });
});
