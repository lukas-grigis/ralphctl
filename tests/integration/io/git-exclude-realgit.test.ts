/**
 * Real-git test for `ensureGitExcludeWildcard` against a LINKED WORKTREE.
 *
 * git resolves `info/exclude` through `$GIT_COMMON_DIR` (the main repo's `.git`), never through
 * the per-worktree gitdir `<main>/.git/worktrees/<name>/`. A fabricated-gitdir unit test can only
 * assert which path was written; it cannot prove the exclude actually takes effect. This test
 * creates a REAL worktree, installs a `ralphctl-*` skill folder into it, and asserts
 * `git status --porcelain` stays clean — the assertion that catches a wrong-path write, which is
 * exactly how the parallel implement path was committing harness-authored skills into user PRs.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const PATTERN = '.claude/skills/ralphctl-*';

const abs = (p: string): AbsolutePath => {
  const parsed = AbsolutePath.parse(p);
  if (!parsed.ok) throw new Error(`test setup: bad path ${p}`);
  return parsed.value;
};

let project: FakeProject | undefined;
let worktreePath: string | undefined;

afterEach(async () => {
  if (worktreePath !== undefined) await fs.rm(worktreePath, { recursive: true, force: true });
  worktreePath = undefined;
  await project?.cleanup();
  project = undefined;
});

describe('ensureGitExcludeWildcard against a real linked worktree', () => {
  it('writes to the common git dir so the pattern actually excludes inside the worktree', async () => {
    project = await createFakeProject();
    const parent = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-wt-')));
    worktreePath = join(parent, 'wt');
    await project.git('worktree', 'add', '-q', '-b', 'wt-branch', worktreePath);

    const result = await ensureGitExcludeWildcard(abs(worktreePath), PATTERN);
    expect(result.ok).toBe(true);

    // The line must land in the COMMON dir — that is the only file git consults.
    const common = await fs.readFile(join(project.path, '.git/info/exclude'), 'utf8');
    expect(common.split('\n').some((line) => line.trim() === PATTERN)).toBe(true);

    // Behavioural proof: a harness-authored skill folder stays invisible to git in the worktree.
    await fs.mkdir(join(worktreePath, '.claude/skills/ralphctl-foo'), { recursive: true });
    await fs.writeFile(join(worktreePath, '.claude/skills/ralphctl-foo/SKILL.md'), '# skill\n', 'utf8');
    // A second `-C` with an absolute path re-targets the fixture's repo-bound git helper.
    const status = await project.git('-C', worktreePath, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });

  it('still excludes in the main checkout after the worktree call (shared common dir)', async () => {
    project = await createFakeProject();
    const parent = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-wt-')));
    worktreePath = join(parent, 'wt');
    await project.git('worktree', 'add', '-q', '-b', 'wt-branch', worktreePath);

    await ensureGitExcludeWildcard(abs(worktreePath), PATTERN);
    await fs.mkdir(join(project.path, '.claude/skills/ralphctl-foo'), { recursive: true });
    await fs.writeFile(join(project.path, '.claude/skills/ralphctl-foo/SKILL.md'), '# skill\n', 'utf8');

    const status = await project.git('status', '--porcelain');
    expect(status.trim()).toBe('');
  });
});
