/**
 * Cancel-scope handler factory hook — wires the two cancel options exposed by the `CancelScopeOverlay`.
 */

import React from 'react';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { cancelActiveTaskUseCase } from '@src/business/task/cancel-active-task.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

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
      try {
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
              clock: IsoTimestamp.now,
            });
          }
        }
      } catch (cause) {
        if (cause instanceof AbortError) throw cause;
        logger.warn('cancel-flow: could not block the active task', {
          error: messageOf(cause),
        });
      } finally {
        // Unwind even when the block write failed — the operator asked for the flow to stop.
        sessions.abort(sessionId);
      }
    })();
  }, [sessions, sessionId, sprintId, currentTask, taskRepo, logger, setCancelScopeOpen]);

  const onDismiss = React.useCallback(() => {
    setCancelScopeOpen(false);
  }, [setCancelScopeOpen]);

  return { onCancelAttempt, onCancelFlow, onDismiss };
};
