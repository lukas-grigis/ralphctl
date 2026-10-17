import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { listDir } from '@src/integration/io/fs.ts';
import { createGitRunner, type GitRunner } from '@src/integration/io/git-runner.ts';
import { gitWorktreeRepairHere } from '@src/integration/io/git-operations.ts';

/** The sprint dir's subdir holding parallel tasks' git worktrees (`wt-<taskId>`). */
export const SPRINT_WORKTREES_DIR = 'worktrees';

// A linked worktree's `.git` is a file; requiring it keeps git from climbing into a repo that encloses the data dir.
const isLinkedWorktree = async (path: string): Promise<boolean> => {
  try {
    return (await fs.lstat(join(path, '.git'))).isFile();
  } catch {
    return false;
  }
};

/**
 * After `sprintDir` was moved (renamed onto its canonical name, or migrated), point git's record of each
 * worktree inside it at the new path. Best-effort: a worktree git can't repair is left as it was.
 */
export const repairSprintWorktrees = async (
  sprintDir: string,
  runner: GitRunner = createGitRunner()
): Promise<void> => {
  const root = join(sprintDir, SPRINT_WORKTREES_DIR);
  const entries = await listDir(root);
  if (!entries.ok) return;
  for (const entry of entries.value) {
    const path = AbsolutePath.parse(join(root, entry));
    if (!path.ok || !(await isLinkedWorktree(String(path.value)))) continue;
    await gitWorktreeRepairHere(runner, path.value);
  }
};
