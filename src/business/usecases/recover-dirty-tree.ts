import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';

export interface RecoverDirtyTreeDeps {
  external: ExternalPort;
  logger: LoggerPort;
  signalBus: SignalBusPort;
}

export interface RecoverDirtyTreeParams {
  sprintId: string;
  taskId: string;
  taskName: string;
  repoPath: string;
}

/**
 * Fence against a dirty working tree after task (or feedback) settlement.
 *
 * The generator and feedback prompts are already instructed to commit their
 * work, and the evaluator is told to stay read-only — so reaching settlement
 * with uncommitted changes is a rare deviation, not the normal path. The
 * harness's philosophy is "never block left and right", so instead of
 * refusing to mark the task done we:
 *
 *   1. log a warning (so the operator sees the deviation),
 *   2. emit a `Note` harness signal so the event lands in `progress.md`
 *      (one durable audit trail — no hidden state), and
 *   3. auto-commit the leftover changes on the harness's behalf.
 *
 * If `autoCommit` itself fails (missing git identity, pre-commit hook
 * rejection, etc.) we log the error and return anyway — the evaluator's
 * preview already treats dirty trees as a Completeness fail, so the human
 * sees the signal via that channel. Blocking task completion on a commit
 * failure would strand progress and is strictly worse than proceeding.
 *
 * Shared between the per-task pipeline's `recover-dirty-tree` step and the
 * end-of-sprint feedback loop so both settlement paths close the same gap.
 */
export async function recoverDirtyTree(deps: RecoverDirtyTreeDeps, params: RecoverDirtyTreeParams): Promise<void> {
  const { external, logger, signalBus } = deps;
  const { sprintId, taskId, taskName, repoPath } = params;

  if (!external.hasUncommittedChanges(repoPath)) return;

  logger.warn(
    `Dirty tree after "${taskName}" — auto-committing on the harness's behalf. The agent should commit its own work; see prompt guidance.`,
    { taskId, projectPath: repoPath }
  );

  signalBus.emit({
    type: 'signal',
    signal: {
      type: 'note',
      text: `harness auto-commit: dirty tree after task "${taskName}" settlement`,
      timestamp: new Date(),
    },
    ctx: { sprintId, taskId, projectPath: repoPath },
  });

  const message = `chore(harness): auto-commit leftover changes from "${taskName}"`;
  try {
    await external.autoCommit(repoPath, message);
  } catch (err) {
    logger.error(`Auto-commit failed in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`, {
      taskId,
      projectPath: repoPath,
    });
    // Intentionally non-blocking: evaluator preview already flags dirty
    // trees as a Completeness fail — do not strand task completion here.
  }
}
