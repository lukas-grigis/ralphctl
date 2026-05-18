import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
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
