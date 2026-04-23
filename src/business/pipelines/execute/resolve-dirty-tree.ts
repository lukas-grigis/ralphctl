import type { ExecutionOptions } from '@src/domain/context.ts';
import { StorageError } from '@src/domain/errors.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';

export interface ResolveDirtyTreeDeps {
  repoPath: string;
  options: ExecutionOptions;
  prompt: PromptPort;
  isTTY: boolean;
  logger: LoggerPort;
  external: ExternalPort;
}

/**
 * Decide what to do about a dirty working tree at sprint resume.
 *
 * Resolution order:
 *   1. Clean tree → no-op.
 *   2. `--reset-on-resume` → hard-reset via `external.hardResetWorkingTree`.
 *   3. `--resume-dirty` → leave tree as-is.
 *   4. Interactive TTY → two-step Y/n prompt:
 *      a) "Resume with existing changes?" (default Y) → leave dirty.
 *      b) "Reset to latest commit and resume?" (default N) → hard-reset.
 *         Decline both → throw abort `StorageError`.
 *   5. Non-interactive + no flag → throw the existing blocking `StorageError`
 *      plus a hint line naming both override flags.
 *
 * Destructive reset only runs on an explicit "Y" to prompt 2 or on the
 * `--reset-on-resume` flag — never as a default.
 */
export async function resolveDirtyTree(deps: ResolveDirtyTreeDeps): Promise<void> {
  const { repoPath, options, prompt, isTTY, logger, external } = deps;

  let dirty: boolean;
  try {
    dirty = external.hasUncommittedChanges(repoPath);
  } catch {
    return;
  }

  if (!dirty) return;

  if (options.resetOnResume) {
    logger.warning(`Resetting working tree to HEAD in ${repoPath}...`);
    external.hardResetWorkingTree(repoPath);
    logger.success(`Working tree reset in ${repoPath}`);
    return;
  }

  if (options.resumeDirty) {
    logger.info(`Resuming with existing changes in ${repoPath}`);
    return;
  }

  if (isTTY) {
    const keepDirty = await prompt.confirm({
      message: `Repository at ${repoPath} has uncommitted changes. Resume with existing changes?`,
      default: true,
    });
    if (keepDirty) {
      logger.info(`Resuming with existing changes in ${repoPath}`);
      return;
    }
    const doReset = await prompt.confirm({
      message: 'Reset to latest commit and resume?',
      default: false,
    });
    if (doReset) {
      logger.warning(`Resetting working tree to HEAD in ${repoPath}...`);
      external.hardResetWorkingTree(repoPath);
      logger.success(`Working tree reset in ${repoPath}`);
      return;
    }
    throw new StorageError('Aborted: commit, stash, or discard changes before resuming.');
  }

  throw new StorageError(
    `Repository at ${repoPath} has uncommitted changes. Commit or stash them before starting.\n` +
      'Hint: pass --resume-dirty to resume with the changes intact, or --reset-on-resume to discard them.'
  );
}
