/**
 * Real-git integration test for untracked-file dirty-tree detection.
 *
 * The bug: when a repo or global gitconfig has `status.showUntrackedFiles=no`,
 * `git status --porcelain` omits untracked files, making a tree whose only changes
 * are new (never-added) files read as fully clean. This breaks every dirty-tree gate:
 * `gitHasUncommittedChanges`, `gitCommitWithMessage`, and `gitStashPush` all read
 * through `gitStatusPorcelain` and inherit the blind spot. Two workarounds already
 * exist in production code (`setup-tree-guard.ts`, `restore-blocked-diff.ts`) that
 * use raw `git status --porcelain --untracked-files=normal` to override the config.
 *
 * The fix: `gitStatusPorcelain` now passes `--untracked-files=normal` so every
 * caller sees a config-independent view. This test verifies the round trip with
 * the config set to `no`.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitHasUncommittedChanges,
  gitCommitWithMessage,
  gitStashPush,
  gitStatusPorcelain,
} from '@src/integration/io/git-operations.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

const abs = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`test setup: bad path ${p}`);
  return r.value;
};

describe('git operations with status.showUntrackedFiles=no', () => {
  let project: FakeProject;
  let cwd: AbsolutePath;
  let gitRunner: ReturnType<typeof createGitRunner>;

  beforeEach(async () => {
    project = await createFakeProject();
    cwd = abs(project.path);
    gitRunner = createGitRunner();

    // Configure the repo to hide untracked files from status.
    await project.git('config', 'status.showUntrackedFiles', 'no');
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('gitStatusPorcelain lists untracked files even with status.showUntrackedFiles=no', async () => {
    // Create an untracked file.
    const newFilePath = join(project.path, 'new-untracked.ts');
    await fs.writeFile(newFilePath, 'export const x = 1;\n', 'utf8');

    // gitStatusPorcelain should see it despite the config.
    const result = await gitStatusPorcelain(gitRunner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({ status: '??', path: 'new-untracked.ts' });
    }
  });

  it('gitHasUncommittedChanges returns true for untracked-only dirt', async () => {
    // Create an untracked file.
    const newFilePath = join(project.path, 'new-untracked.ts');
    await fs.writeFile(newFilePath, 'export const x = 1;\n', 'utf8');

    // The tree is dirty from gitHasUncommittedChanges's perspective.
    const result = await gitHasUncommittedChanges(gitRunner, cwd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('gitCommitWithMessage commits untracked-only changes', async () => {
    // Create an untracked file.
    const newFilePath = join(project.path, 'new-untracked.ts');
    await fs.writeFile(newFilePath, 'export const x = 1;\n', 'utf8');

    // Commit it.
    const result = await gitCommitWithMessage(gitRunner, cwd, 'feat: add new file');
    if (!result.ok || !result.value.committed) {
      throw new Error(`expected the untracked-only change to be committed, got: ${JSON.stringify(result)}`);
    }
    expect(result.value.headSha).toMatch(/^[0-9a-f]{7,64}$/i);

    // Verify the file appears in the commit.
    const showStat = await project.git('show', '--stat', '--format=', 'HEAD');
    expect(showStat).toContain('new-untracked.ts');
  });

  it('gitStashPush stashes untracked-only changes', async () => {
    // Create an untracked file.
    const newFilePath = join(project.path, 'new-untracked.ts');
    const fileContent = 'export const x = 1;\n';
    await fs.writeFile(newFilePath, fileContent, 'utf8');

    // Stash it.
    const stashResult = await gitStashPush(gitRunner, cwd, 'test-stash');
    expect(stashResult.ok).toBe(true);
    if (stashResult.ok) expect(stashResult.value.stashed).toBe(true);

    // File must be gone from the working tree.
    const fileExists = await fs
      .access(newFilePath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);

    // Verify the stash exists with the message.
    const listResult = await project.git('stash', 'list', '--format=%s');
    expect(listResult).toContain('test-stash');
  });
});
