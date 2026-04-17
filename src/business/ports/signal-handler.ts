/**
 * Signal handler port — interface for handling parsed HarnessSignal objects.
 *
 * The harness uses this port to process signals and write outputs:
 * - Progress signals → append to progress.md
 * - Evaluation signals → append to evaluations/<taskId>.md, update tasks.json
 * - Task lifecycle signals → update task status in tasks.json
 * - Note signals → append to progress.md
 *
 * All handlers are async and return Result<void, DomainError>.
 */

import type { DomainResult } from '@src/domain/types.ts';
import type {
  ProgressSignal,
  EvaluationSignal,
  TaskCompleteSignal,
  TaskVerifiedSignal,
  TaskBlockedSignal,
  NoteSignal,
} from '@src/domain/signals.ts';

/**
 * Context provided to signal handlers — minimal but sufficient for file writes.
 */
export interface SignalContext {
  sprintId: string; // Required: needed for all file operations
  taskId?: string; // Optional: needed for task/evaluation signals
  projectPath?: string; // Optional: may be used for progress.md project marker
}

/**
 * Port interface for signal handling.
 * Each handler method processes one signal type and performs file I/O.
 */
export interface SignalHandlerPort {
  /**
   * Handle progress signal — append to progress.md.
   *
   * @param signal Progress signal with summary and optional file list
   * @param ctx Signal context (sprintId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Appends timestamped entry to <sprintDir>/progress.md
   * - Includes project marker if projectPath provided
   * - Lists modified files if provided in signal
   * - Uses file lock to prevent concurrent corruption
   */
  handleProgress(signal: ProgressSignal, ctx: SignalContext): Promise<DomainResult<void>>;

  /**
   * Handle evaluation signal — append to evaluations/<taskId>.md and update tasks.json.
   *
   * @param signal Evaluation signal with status, dimensions, and optional critique
   * @param ctx Signal context (sprintId and taskId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Appends full critique to <sprintDir>/evaluations/<taskId>.md (one entry per iteration)
   * - Updates tasks.json with:
   *   - evaluationOutput: first 2000 chars of critique
   *   - evaluationStatus: 'passed' | 'failed' | 'malformed'
   *   - evaluationFile: pointer to sidecar file
   *   - evaluated: true
   * - No file lock (evaluation is not concurrent like progress)
   */
  handleEvaluation(signal: EvaluationSignal, ctx: SignalContext): Promise<DomainResult<void>>;

  /**
   * Handle task complete signal — mark task as done.
   *
   * @param signal Task complete signal (minimal, just a timestamp)
   * @param ctx Signal context (sprintId and taskId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Updates task.status to 'done'
   * - Records completion timestamp
   * - Signals downstream that task execution is complete
   */
  handleTaskComplete(signal: TaskCompleteSignal, ctx: SignalContext): Promise<DomainResult<void>>;

  /**
   * Handle task verified signal — record verification output.
   *
   * @param signal Task verified signal with verification output
   * @param ctx Signal context (sprintId and taskId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Updates task.verified to true
   * - Records verification output to task.verificationOutput
   * - Signals that task has passed verification criteria
   */
  handleTaskVerified(signal: TaskVerifiedSignal, ctx: SignalContext): Promise<DomainResult<void>>;

  /**
   * Handle task blocked signal — pause execution for this task.
   *
   * @param signal Task blocked signal with reason for blockage
   * @param ctx Signal context (sprintId and taskId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Records blocker reason to progress.md
   * - Marks task as blocked (execution paused, not retried)
   * - Allows other independent tasks to continue
   */
  handleTaskBlocked(signal: TaskBlockedSignal, ctx: SignalContext): Promise<DomainResult<void>>;

  /**
   * Handle note signal — append informational note to progress.md.
   *
   * @param signal Note signal with informational text
   * @param ctx Signal context (sprintId required)
   * @returns Result<void, DomainError>
   *
   * Behavior:
   * - Appends note to progress.md (no timestamp prefix, just content)
   * - Useful for agent-generated learnings or context notes
   * - Uses file lock to prevent concurrent corruption (like progress)
   */
  handleNote(signal: NoteSignal, ctx: SignalContext): Promise<DomainResult<void>>;
}
