/**
 * Signal handler adapter — implements SignalHandlerPort by delegating to existing file-writing utilities.
 *
 * This adapter connects parsed HarnessSignal objects to the harness's file I/O layer:
 * - Progress signals → logProgress() from progress.ts
 * - Evaluation signals → writeEvaluation() from evaluation.ts + updateTask() for preview
 * - Task lifecycle signals → updateTask() from task.ts
 * - Note signals → logProgress() (or separate note append)
 *
 * All handlers return Result<void, DomainError> for error handling at call sites.
 */

import type {
  ProgressSignal,
  EvaluationSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
  TaskBlockedSignal,
  NoteSignal,
} from '@src/domain/signals.ts';
import type { DomainResult } from '@src/domain/types.ts';
import type { SignalHandlerPort, SignalContext } from '@src/business/ports/signal-handler.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { logProgress } from '@src/integration/persistence/progress.ts';
import { writeEvaluation } from '@src/integration/persistence/evaluation.ts';
import { updateTask, updateTaskStatus } from '@src/integration/persistence/task.ts';
import type { DomainError } from '@src/domain/errors.ts';
import { StorageError } from '@src/domain/errors.ts';

const MAX_EVAL_OUTPUT = 2000; // Preview cap stored in tasks.json — full critique lives in the sidecar.

/**
 * Convert thrown error to DomainError for wrapAsync error mapping.
 * Store functions throw domain errors directly, which inherit from DomainError.
 */
function errorToDomainError(err: unknown): DomainError {
  if (err instanceof Error && 'code' in err) {
    return err as DomainError; // Already a DomainError
  }
  return new StorageError(err instanceof Error ? err.message : String(err));
}

/**
 * File-based signal handler — delegates to existing harness utilities.
 *
 * Directly imports and calls store functions to handle signals.
 * Constructor is present for consistency with port interface pattern.
 */
export class FileSystemSignalHandler implements SignalHandlerPort {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars
  constructor(_persistence: PersistencePort) {
    // Unused for now — delegates to existing store modules directly
  }

  async handleProgress(signal: ProgressSignal, ctx: SignalContext): Promise<DomainResult<void>> {
    return wrapAsync(async () => {
      const message = signal.summary;
      await logProgress(message, {
        sprintId: ctx.sprintId,
        projectPath: ctx.projectPath,
      });
    }, errorToDomainError);
  }

  async handleEvaluation(signal: EvaluationSignal, ctx: SignalContext): Promise<DomainResult<void>> {
    if (!ctx.taskId) {
      throw new Error('handleEvaluation requires taskId in context');
    }

    const taskId = ctx.taskId; // Narrow to non-undefined

    return wrapAsync(async () => {
      // Determine iteration number (Phase 1: always 1; Phase 3+ will track iterations)
      const iteration = 1;

      // Write full critique to sidecar
      const evaluationFilePath = await writeEvaluation(
        ctx.sprintId,
        taskId,
        iteration,
        signal.status,
        signal.critique ?? ''
      );

      // Update task with preview + status + file pointer
      const preview = (signal.critique ?? '').slice(0, MAX_EVAL_OUTPUT);
      await updateTask(
        taskId,
        {
          evaluated: true,
          evaluationStatus: signal.status,
          evaluationOutput: preview,
          evaluationFile: evaluationFilePath,
        },
        ctx.sprintId
      );
    }, errorToDomainError);
  }

  async handleTaskComplete(_signal: TaskCompleteSignal, ctx: SignalContext): Promise<DomainResult<void>> {
    if (!ctx.taskId) {
      throw new Error('handleTaskComplete requires taskId in context');
    }

    const taskId = ctx.taskId; // Narrow to non-undefined

    return wrapAsync(async () => {
      await updateTaskStatus(taskId, 'done', ctx.sprintId);
    }, errorToDomainError);
  }

  async handleTaskVerified(signal: TaskVerifiedSignal, ctx: SignalContext): Promise<DomainResult<void>> {
    if (!ctx.taskId) {
      throw new Error('handleTaskVerified requires taskId in context');
    }

    const taskId = ctx.taskId; // Narrow to non-undefined

    return wrapAsync(async () => {
      await updateTask(
        taskId,
        {
          verified: true,
          verificationOutput: signal.output,
        },
        ctx.sprintId
      );
    }, errorToDomainError);
  }

  async handleTaskBlocked(signal: TaskBlockedSignal, _ctx: SignalContext): Promise<DomainResult<void>> {
    // taskId not needed for this handler (only logs to progress)

    return wrapAsync(async () => {
      // Log blocker to progress
      const message = `**Task Blocked:** ${signal.reason}`;
      await logProgress(message, {
        sprintId: _ctx.sprintId,
        projectPath: _ctx.projectPath,
      });

      // Mark task as blocked (future: add task.blocked field to schema)
      // For now, just log — Phase 2+ will add schema field for explicit blocking
    }, errorToDomainError);
  }

  async handleNote(signal: NoteSignal, ctx: SignalContext): Promise<DomainResult<void>> {
    return wrapAsync(async () => {
      const message = `**Note:** ${signal.text}`;
      await logProgress(message, {
        sprintId: ctx.sprintId,
        projectPath: ctx.projectPath,
      });
    }, errorToDomainError);
  }
}
