/**
 * Cancel-scope handler factory hook — wires the two cancel options exposed by the
 * `CancelScopeOverlay`. Both stop the run now via a chain-runner abort; there is no live
 * retry. The two paths differ only in the task state they leave behind:
 *
 *   1. Stop run now (`onCancelAttempt`) — chain-runner abort with no repo write. The task
 *      stays `in_progress`; the next launch resumes it (the harness detects the settled
 *      attempt and re-enters the gen-eval loop rather than re-queuing from scratch).
 *   2. Stop run and mark blocked (`onCancelFlow`) — marks the current task `blocked` via
 *      `cancelActiveTaskUseCase` (reason: 'user cancel', scope: 'own'), then aborts the
 *      chain. The block keeps the task off the auto-resume queue on the next launch. The
 *      unwind is otherwise identical to option 1 from the runner's perspective.
 *
 * The repo write happens BEFORE the abort so a follow-up settle-attempt-leaf in the same
 * tick can't overwrite our pin to `blocked`.
 */

import React from 'react';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { cancelActiveTaskUseCase } from '@src/business/task/cancel-active-task.ts';

interface UseCancelHandlersInput {
  readonly sessions: SessionManager;
  readonly sessionId: string;
  readonly sprintId: SprintId | undefined;
  readonly currentTask: TaskBucket | undefined;
  readonly taskRepo: AppDeps['taskRepo'] | undefined;
  readonly logger: AppDeps['logger'];
  readonly setCancelScopeOpen: (open: boolean) => void;
}

export interface CancelHandlers {
  readonly onCancelAttempt: () => void;
  readonly onCancelFlow: () => void;
  readonly onDismiss: () => void;
}

export const useCancelHandlers = ({
  sessions,
  sessionId,
  sprintId,
  currentTask,
  taskRepo,
  logger,
  setCancelScopeOpen,
}: UseCancelHandlersInput): CancelHandlers => {
  const onCancelAttempt = React.useCallback(() => {
    setCancelScopeOpen(false);
    sessions.abort(sessionId);
  }, [sessions, sessionId, setCancelScopeOpen]);

  const onCancelFlow = React.useCallback(() => {
    setCancelScopeOpen(false);
    void (async (): Promise<void> => {
      const taskIdRaw = currentTask?.id;
      if (sprintId !== undefined && taskIdRaw !== undefined && taskRepo !== undefined) {
        const taskId = taskIdRaw as TaskId;
        const found = await taskRepo.findById(sprintId, taskId);
        if (found.ok) {
          await cancelActiveTaskUseCase({
            task: found.value,
            sprintId,
            reason: 'user cancel',
            taskRepo,
            logger,
          });
        }
      }
      sessions.abort(sessionId);
    })();
  }, [sessions, sessionId, sprintId, currentTask, taskRepo, logger, setCancelScopeOpen]);

  const onDismiss = React.useCallback(() => {
    setCancelScopeOpen(false);
  }, [setCancelScopeOpen]);

  return { onCancelAttempt, onCancelFlow, onDismiss };
};
