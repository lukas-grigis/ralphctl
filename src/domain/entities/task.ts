import { Result } from 'typescript-result';

import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import type { TicketId } from '@src/domain/values/ticket-id.ts';
import { ValidationError } from '@src/domain/values/validation-error.ts';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type EvaluationStatus = 'passed' | 'failed' | 'malformed';

/** Construction inputs for {@link Task.create}. */
export interface TaskCreateInput {
  readonly id?: TaskId;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly string[];
  readonly order: number;
  readonly ticketId?: TicketId;
  readonly blockedBy?: readonly TaskId[];
  readonly projectPath: AbsolutePath;
  readonly extraDimensions?: readonly string[];
}

/** Inputs to {@link Task.recordEvaluation}. */
export interface RecordEvaluationInput {
  readonly output: string;
  readonly status: EvaluationStatus;
  readonly file: string;
}

/**
 * `Task` — aggregate root referencing the owning sprint by id (the actual
 * `Sprint` value is reconstituted at the use-case layer when needed).
 *
 * Status transitions are linear: `todo → in_progress → done`. A task can also
 * branch off into `blocked` from `todo` or `in_progress` (e.g. when the
 * harness can't proceed because the repo is on the wrong branch); a blocked
 * task can be `unblock()`ed back to `todo` once the obstruction is cleared.
 *
 * Recording verification or evaluation output is allowed at any time so the
 * harness can persist intermediate observations without juggling state
 * guards.
 */
export class Task {
  readonly id: TaskId;
  readonly name: string;
  readonly description: string | undefined;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly string[];
  readonly status: TaskStatus;
  readonly order: number;
  readonly ticketId: TicketId | undefined;
  readonly blockedBy: readonly TaskId[];
  readonly projectPath: AbsolutePath;
  readonly verified: boolean;
  readonly verificationOutput: string | undefined;
  readonly evaluated: boolean;
  readonly evaluationOutput: string | undefined;
  readonly evaluationStatus: EvaluationStatus | undefined;
  readonly evaluationFile: string | undefined;
  readonly extraDimensions: readonly string[] | undefined;
  readonly blockedReason: string | undefined;
  readonly commitSha: string | undefined;

  private constructor(props: {
    id: TaskId;
    name: string;
    description: string | undefined;
    steps: readonly string[];
    verificationCriteria: readonly string[];
    status: TaskStatus;
    order: number;
    ticketId: TicketId | undefined;
    blockedBy: readonly TaskId[];
    projectPath: AbsolutePath;
    verified: boolean;
    verificationOutput: string | undefined;
    evaluated: boolean;
    evaluationOutput: string | undefined;
    evaluationStatus: EvaluationStatus | undefined;
    evaluationFile: string | undefined;
    extraDimensions: readonly string[] | undefined;
    blockedReason: string | undefined;
    commitSha: string | undefined;
  }) {
    this.id = props.id;
    this.name = props.name;
    this.description = props.description;
    this.steps = props.steps;
    this.verificationCriteria = props.verificationCriteria;
    this.status = props.status;
    this.order = props.order;
    this.ticketId = props.ticketId;
    this.blockedBy = props.blockedBy;
    this.projectPath = props.projectPath;
    this.verified = props.verified;
    this.verificationOutput = props.verificationOutput;
    this.evaluated = props.evaluated;
    this.evaluationOutput = props.evaluationOutput;
    this.evaluationStatus = props.evaluationStatus;
    this.evaluationFile = props.evaluationFile;
    this.extraDimensions = props.extraDimensions;
    this.blockedReason = props.blockedReason;
    this.commitSha = props.commitSha;
  }

  static create(input: TaskCreateInput): Result<Task, ValidationError> {
    const name = input.name.trim();
    if (name.length === 0) {
      return Result.error(
        new ValidationError({
          field: 'task.name',
          value: input.name,
          message: 'task name must be a non-empty string',
        })
      );
    }

    if (!Number.isFinite(input.order) || !Number.isInteger(input.order) || input.order <= 0) {
      return Result.error(
        new ValidationError({
          field: 'task.order',
          value: input.order,
          message: 'task order must be a positive 1-indexed integer',
        })
      );
    }

    const description = input.description?.trim();

    return Result.ok(
      new Task({
        id: input.id ?? TaskId.generate(),
        name,
        description: description !== undefined && description.length > 0 ? description : undefined,
        steps: [...input.steps],
        verificationCriteria: [...input.verificationCriteria],
        status: 'todo',
        order: input.order,
        ticketId: input.ticketId,
        blockedBy: input.blockedBy === undefined ? [] : [...input.blockedBy],
        projectPath: input.projectPath,
        verified: false,
        verificationOutput: undefined,
        evaluated: false,
        evaluationOutput: undefined,
        evaluationStatus: undefined,
        evaluationFile: undefined,
        extraDimensions: input.extraDimensions === undefined ? undefined : [...input.extraDimensions],
        blockedReason: undefined,
        commitSha: undefined,
      })
    );
  }

  // ───────────────────────── status transitions ─────────────────────────

  /**
   * Transition to `in_progress`.
   *
   * Idempotent on `in_progress`: a task that was already started — typically
   * because the prior process died mid-task and the harness is now resuming
   * — short-circuits and returns the same instance unchanged. Without this,
   * resuming an interrupted sprint blows up at the per-task chain's
   * `mark-in-progress` step and leaves the runner in a bad state.
   *
   * Rejected from `done` (a finished task can't regress) and from `blocked`
   * (the caller must `unblock()` first to make the intent explicit).
   */
  markInProgress(): Result<Task, InvalidStateError> {
    if (this.status === 'in_progress') {
      return Result.ok(this);
    }
    if (this.status !== 'todo') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'mark-in-progress',
          hint: 'Only `todo` or `in_progress` tasks can be marked in-progress.',
        })
      );
    }
    return Result.ok(this.with({ status: 'in_progress' }));
  }

  markDone(): Result<Task, InvalidStateError> {
    if (this.status !== 'in_progress') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'mark-done',
          hint: 'Only `in_progress` tasks can be marked done.',
        })
      );
    }
    return Result.ok(this.with({ status: 'done' }));
  }

  /**
   * Mark the task as blocked with a human-readable reason. Allowed from
   * `todo` or `in_progress` — a task can be blocked before it starts (e.g.
   * a branch-preflight failure prevents work from beginning) or while
   * already in flight (e.g. an external dependency goes down mid-task).
   *
   * Rejected from `done` (a finished task cannot regress) and from
   * `blocked` itself (re-marking is a no-op the caller should treat
   * explicitly via `unblock()` first).
   */
  markBlocked(reason: string): Result<Task, InvalidStateError> {
    if (this.status !== 'todo' && this.status !== 'in_progress') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'mark-blocked',
          hint: 'Done or already-blocked tasks cannot be re-blocked.',
        })
      );
    }
    return Result.ok(this.with({ status: 'blocked', blockedReason: reason }));
  }

  /**
   * Clear a `blocked` status, returning the task to `todo`. The
   * `blockedReason` is wiped at the same time. Rejected from any other
   * state — there is nothing to unblock.
   */
  unblock(): Result<Task, InvalidStateError> {
    if (this.status !== 'blocked') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'unblock',
        })
      );
    }
    return Result.ok(this.with({ status: 'todo', blockedReason: undefined }));
  }

  /**
   * Reset a stale `in_progress` task back to `todo`. Used by `executeFlow`
   * at sprint-start to recover from a prior run that was killed/interrupted
   * after `mark-in-progress` ran but before the task settled — without this,
   * the task panel shows phantom `IN PROGRESS` pills on the next launch.
   *
   * Idempotent on `todo`. Rejected from `done` (a finished task cannot
   * regress) and from `blocked` (use `unblock()` to make the intent
   * explicit).
   */
  resetToTodo(): Result<Task, InvalidStateError> {
    if (this.status === 'todo') return Result.ok(this);
    if (this.status !== 'in_progress') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'reset-to-todo',
          hint: 'Only `in_progress` tasks can be reset to todo.',
        })
      );
    }
    return Result.ok(this.with({ status: 'todo' }));
  }

  /**
   * Apply an in-place edit to the task's mutable fields. Locked once the
   * task starts running — only `todo` tasks can be edited so we don't
   * silently rewrite the contract under an in-flight or completed task.
   *
   * `description` and `extraDimensions` accept `null` as an explicit "clear"
   * signal so callers can wipe the field without juggling a separate clear
   * method (mirrors the `with()` partial idiom).
   */
  update(input: {
    name?: string;
    description?: string | null;
    steps?: readonly string[];
    verificationCriteria?: readonly string[];
    blockedBy?: readonly TaskId[];
    projectPath?: AbsolutePath;
    extraDimensions?: readonly string[] | null;
  }): Result<Task, ValidationError | InvalidStateError> {
    if (this.status !== 'todo') {
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: this.status,
          attemptedAction: 'update',
        })
      );
    }

    let nextName = this.name;
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length === 0) {
        return Result.error(
          new ValidationError({
            field: 'task.name',
            value: input.name,
            message: 'task name must be a non-empty string',
          })
        );
      }
      nextName = trimmed;
    }

    let nextDescription = this.description;
    if (input.description !== undefined) {
      if (input.description === null) {
        nextDescription = undefined;
      } else {
        const trimmed = input.description.trim();
        nextDescription = trimmed.length > 0 ? trimmed : undefined;
      }
    }

    let nextExtraDimensions = this.extraDimensions;
    if (input.extraDimensions !== undefined) {
      nextExtraDimensions = input.extraDimensions === null ? undefined : [...input.extraDimensions];
    }

    return Result.ok(
      new Task({
        id: this.id,
        name: nextName,
        description: nextDescription,
        steps: input.steps !== undefined ? [...input.steps] : this.steps,
        verificationCriteria:
          input.verificationCriteria !== undefined ? [...input.verificationCriteria] : this.verificationCriteria,
        status: this.status,
        order: this.order,
        ticketId: this.ticketId,
        blockedBy: input.blockedBy !== undefined ? [...input.blockedBy] : this.blockedBy,
        projectPath: input.projectPath ?? this.projectPath,
        verified: this.verified,
        verificationOutput: this.verificationOutput,
        evaluated: this.evaluated,
        evaluationOutput: this.evaluationOutput,
        evaluationStatus: this.evaluationStatus,
        evaluationFile: this.evaluationFile,
        extraDimensions: nextExtraDimensions,
        blockedReason: this.blockedReason,
        commitSha: this.commitSha,
      })
    );
  }

  // ───────────────────────── output recording ─────────────────────────

  recordVerification(output: string): Task {
    return this.with({ verified: true, verificationOutput: output });
  }

  recordEvaluation(input: RecordEvaluationInput): Task {
    return this.with({
      evaluated: true,
      evaluationOutput: input.output,
      evaluationStatus: input.status,
      evaluationFile: input.file,
    });
  }

  /**
   * Record the harness commit that captured the work for this task. Called
   * by the per-task chain's `commit-task` leaf after `git add -A && git
   * commit`. Idempotent — recording the same SHA twice produces an
   * equivalent task. Allowed at any time so the chain can persist commits
   * regardless of status.
   */
  recordCommit(sha: string): Task {
    return this.with({ commitSha: sha });
  }

  // ───────────────────────── dependencies ─────────────────────────

  setBlockedBy(deps: readonly TaskId[]): Task {
    return this.with({ blockedBy: [...deps] });
  }

  // ───────────────────────── internal ─────────────────────────

  private with(
    partial: Partial<{
      status: TaskStatus;
      blockedBy: readonly TaskId[];
      verified: boolean;
      verificationOutput: string | undefined;
      evaluated: boolean;
      evaluationOutput: string | undefined;
      evaluationStatus: EvaluationStatus | undefined;
      evaluationFile: string | undefined;
      blockedReason: string | undefined;
      commitSha: string | undefined;
    }>
  ): Task {
    return new Task({
      id: this.id,
      name: this.name,
      description: this.description,
      steps: this.steps,
      verificationCriteria: this.verificationCriteria,
      status: partial.status ?? this.status,
      order: this.order,
      ticketId: this.ticketId,
      blockedBy: partial.blockedBy ?? this.blockedBy,
      projectPath: this.projectPath,
      verified: partial.verified ?? this.verified,
      verificationOutput: 'verificationOutput' in partial ? partial.verificationOutput : this.verificationOutput,
      evaluated: partial.evaluated ?? this.evaluated,
      evaluationOutput: 'evaluationOutput' in partial ? partial.evaluationOutput : this.evaluationOutput,
      evaluationStatus: 'evaluationStatus' in partial ? partial.evaluationStatus : this.evaluationStatus,
      evaluationFile: 'evaluationFile' in partial ? partial.evaluationFile : this.evaluationFile,
      extraDimensions: this.extraDimensions,
      blockedReason: 'blockedReason' in partial ? partial.blockedReason : this.blockedReason,
      commitSha: 'commitSha' in partial ? partial.commitSha : this.commitSha,
    });
  }
}
