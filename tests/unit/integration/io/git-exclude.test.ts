import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';

const makeRoot = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'git-exclude-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const PATTERN = '.claude/skills/ralphctl-*';

describe('ensureGitExcludeWildcard', () => {
  it('is a no-op when .git is missing (non-git working tree)', async () => {
    const root = await makeRoot();
    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);
  });

  it('appends the pattern to a plain-repo .git/info/exclude', async () => {
    const root = await makeRoot();
    await mkdir(join(String(root), '.git/info'), { recursive: true });
    await writeFile(join(String(root), '.git/info/exclude'), '# default\n', 'utf8');

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);

    const content = await readFile(join(String(root), '.git/info/exclude'), 'utf8');
    expect(content).toBe(`# default\n${PATTERN}\n`);
  });

  it('creates the info/exclude file when only .git/ exists with no info/ subdir', async () => {
    const root = await makeRoot();
    await mkdir(join(String(root), '.git'), { recursive: true });

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);

    const content = await readFile(join(String(root), '.git/info/exclude'), 'utf8');
    expect(content).toBe(`${PATTERN}\n`);
  });

  it('is idempotent — second call with the same pattern does not duplicate', async () => {
    const root = await makeRoot();
    await mkdir(join(String(root), '.git/info'), { recursive: true });

    await ensureGitExcludeWildcard(root, PATTERN);
    await ensureGitExcludeWildcard(root, PATTERN);

    const content = await readFile(join(String(root), '.git/info/exclude'), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim() === PATTERN);
    expect(lines).toHaveLength(1);
  });

  it('treats whitespace-equivalent lines as already-present', async () => {
    const root = await makeRoot();
    await mkdir(join(String(root), '.git/info'), { recursive: true });
    await writeFile(join(String(root), '.git/info/exclude'), `  ${PATTERN}  \n`, 'utf8');

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);

    const content = await readFile(join(String(root), '.git/info/exclude'), 'utf8');
    expect(content).toBe(`  ${PATTERN}  \n`);
  });

  it('follows the worktree commondir pointer — git only reads the COMMON info/exclude', async () => {
    const main = await makeRoot();
    const gitdir = join(String(main), '.git/worktrees/wt');
    await mkdir(join(gitdir, 'info'), { recursive: true });
    await mkdir(join(String(main), '.git/info'), { recursive: true });
    // git writes `commondir` into every linked-worktree gitdir, relative to that gitdir.
    await writeFile(join(gitdir, 'commondir'), '../..\n', 'utf8');

    const worktree = await makeRoot();
    await writeFile(join(String(worktree), '.git'), `gitdir: ${gitdir}\n`, 'utf8');

    const result = await ensureGitExcludeWildcard(worktree, PATTERN);
    expect(result.ok).toBe(true);

    const common = await readFile(join(String(main), '.git/info/exclude'), 'utf8');
    expect(common).toBe(`${PATTERN}\n`);
    // The per-worktree gitdir copy is the file git ignores — it must stay untouched.
    await expect(readFile(join(gitdir, 'info/exclude'), 'utf8')).rejects.toThrow();
  });

  it('accepts an absolute commondir path', async () => {
    const main = await makeRoot();
    const gitdir = await mkdtemp(join(tmpdir(), 'wt-gitdir-'));
    await mkdir(join(String(main), '.git/info'), { recursive: true });
    await writeFile(join(gitdir, 'commondir'), `${join(String(main), '.git')}\n`, 'utf8');

    const worktree = await makeRoot();
    await writeFile(join(String(worktree), '.git'), `gitdir: ${gitdir}\n`, 'utf8');

    const result = await ensureGitExcludeWildcard(worktree, PATTERN);
    expect(result.ok).toBe(true);

    const common = await readFile(join(String(main), '.git/info/exclude'), 'utf8');
    expect(common).toBe(`${PATTERN}\n`);
  });

  it('returns an error Result instead of throwing when .git cannot be inspected', async () => {
    const root = await makeRoot();
    // A self-referential symlink makes stat() fail with ELOOP — neither ENOENT nor ENOTDIR.
    await symlink('.git', join(String(root), '.git'));

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBeInstanceOf(StorageError);
    // The raw errno ('ELOOP') must NOT become the error code — it is a Node code, not a domain one.
    expect(result.error.code).toBe(ErrorCode.Storage);
    expect(result.error.subCode).toBe('io');
    expect(result.error.path?.endsWith('/.git')).toBe(true);
    // …but it stays reachable on `.cause` so the failure is still diagnosable from a logger.warn.
    expect((result.error.cause as { code?: unknown } | undefined)?.code).toBe('ELOOP');
  });

  it('resolves the worktree pointer file (.git is a file containing gitdir:)', async () => {
    const root = await makeRoot();
    const realGitDir = await mkdtemp(join(tmpdir(), 'real-gitdir-'));
    await mkdir(join(realGitDir, 'info'), { recursive: true });
    await writeFile(join(realGitDir, 'info/exclude'), '# wt default\n', 'utf8');
    await writeFile(join(String(root), '.git'), `gitdir: ${realGitDir}\n`, 'utf8');

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);

    const content = await readFile(join(realGitDir, 'info/exclude'), 'utf8');
    expect(content).toBe(`# wt default\n${PATTERN}\n`);
  });

  it('preserves a trailing-newline-less file by adding the separator', async () => {
    const root = await makeRoot();
    await mkdir(join(String(root), '.git/info'), { recursive: true });
    await writeFile(join(String(root), '.git/info/exclude'), '# default', 'utf8');

    const result = await ensureGitExcludeWildcard(root, PATTERN);
    expect(result.ok).toBe(true);

    const content = await readFile(join(String(root), '.git/info/exclude'), 'utf8');
    expect(content).toBe(`# default\n${PATTERN}\n`);
  });
});
