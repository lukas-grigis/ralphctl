import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { gitStashPushPath } from '@src/integration/io/git-stash.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

interface DiscardedTest {
  readonly cwd: AbsolutePath;
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  /** The session's word for it, so it is checked before git sees it. */
  readonly testPath: string;
}

/** Carries sprint and task as worktrees share one stash list; nothing pops this suffix, so it is never restored. */
export const discardedReproductionStashMessage = (sprintId: SprintId, taskId: TaskId): string =>
  `ralphctl/${String(sprintId)}/${String(taskId)}/discarded-reproduction`;

/** `testPath` under `cwd`, or undefined when it can't be one path there: `.` would stash the whole tree. */
const pathWithinCwd = (cwd: AbsolutePath, testPath: string): string | undefined => {
  if (isAbsolute(testPath)) return undefined;
  const rel = relative(String(cwd), resolve(String(cwd), testPath));
  return rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ? undefined : rel;
};

const isDirectory = (path: string): Promise<boolean> =>
  fs.lstat(path).then(
    (stats) => stats.isDirectory(),
    () => false
  );

/**
 * Stash a discarded reproduction's test, that one path only: left in place a killed test hangs the
 * next verify run, and a blanket stash would take earlier work the tree may legitimately hold.
 * Best-effort: every failure warns and the task carries on.
 */
export const setAsideDiscardedTest = async (
  deps: { readonly gitRunner: GitRunner; readonly log: Logger },
  test: DiscardedTest
): Promise<void> => {
  const { gitRunner, log } = deps;
  const { cwd, testPath } = test;
  const context = { taskId: String(test.taskId), testPath };
  const path = pathWithinCwd(cwd, testPath);
  if (path === undefined || (await isDirectory(join(String(cwd), path)))) {
    log.warn('discarded reproduction test is not one file in the repo — nothing set aside', context);
    return;
  }
  const message = discardedReproductionStashMessage(test.sprintId, test.taskId);
  const stashed = await gitStashPushPath(gitRunner, cwd, message, path);
  if (!stashed.ok) {
    log.warn('could not set the discarded reproduction test aside — it stays in the working tree', {
      ...context,
      error: stashed.error.message,
    });
    return;
  }
  if (stashed.value.stashed) log.info('discarded reproduction test set aside', { ...context, stashMessage: message });
};
