import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import {
  type AbortMetadata,
  appendVerifyRun,
  type Attempt,
  type AttemptWarning,
  type Attribution,
  type VerifyRun,
  completeAttempt,
  type Evaluation,
  markBaselineBroken,
  recordAttemptCommit,
  recordAttemptCritique,
  recordAttemptEvaluation,
  recordAttemptVerification,
  recordAttemptWarning,
  type RecoveryContext,
  type RunningAttempt,
  setAttribution,
  startAttempt,
  type VerifiedAttempt,
} from '@src/domain/entity/attempt.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parsePositiveInt } from '@src/domain/value/parsers/parse-positive-int.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

// Re-exports — these types conceptually belong to Attempt but were historically used
// alongside Task. Kept here for ergonomic imports.
export type {
  Attribution,
  VerifyRun,
  VerifyRunOutcome,
  VerifyRunPhase,
  Evaluation,
  EvaluationStatus,
  Verification,
} from '@src/domain/entity/attempt.ts';

/**
 * Structured "definition of done" entry attached to a {@link Task}.
 *
 *  - `id` is stable within the task (e.g. `C1`, `C2`) — the evaluator cites it verbatim when
 *    grading per-criterion PASS / FAIL and the same id surfaces in `contract.md` and
 *    `evaluation.md` so an operator can trace a failure back to the source criterion.
 *  - `assertion` is the human-readable statement of the check.
 *  - `check` partitions criteria into two operational categories:
 *      `auto`   — the evaluator runs `command` and records the verbatim output as evidence.
 *                 `command` is required (domain invariant on `createTask` / `updateTask`).
 *      `manual` — the evaluator inspects the code / state and cites a specific location as
 *                 evidence. `command` MUST be absent.
 */
export interface VerificationCriterion {
  readonly id: string;
  readonly assertion: string;
  readonly check: 'auto' | 'manual';
  readonly command?: string;
}

interface TaskBase extends Entity<TaskId> {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
  readonly order: number;
  /** Required: every task is born from refining a ticket. */
  readonly ticketId: TicketId;
  /** Prerequisite tasks that must be `done` before this one is available. */
  readonly dependsOn: readonly TaskId[];
  readonly repositoryId: RepositoryId;
  /** Append-only history of generator–evaluator iterations. Empty until first `startNextAttempt`. */
  readonly attempts: readonly Attempt[];
  /** Cap for `attempts.length`. Once reached, `failCurrentAttempt` transitions to `blocked`. */
  readonly maxAttempts?: number;
  readonly extraDimensions?: readonly string[];
  /**
   * Verbatim external tracker references inherited from the originating ticket — e.g.
   * `['#123']`, `['!456']`, `['PROJ-7']`. Currently always derived from `Ticket.externalRef`
   * (1:1 ticketId mapping at plan / ideate time), but typed as an array to allow future
   * fan-in (one task synthesised from multiple tickets) without a schema migration.
   *
   * Surfaced in the implement prompt's commit-message trailer (`Refs: #123, #124`) and in the
   * PR / MR body's `## Related issues` section. Absent → no trailer, no entry.
   */
  readonly externalRefs?: readonly string[];
  /**
   * Generator model id the task was originally configured with at the moment a plateau
   * escalation fired. Stamped by the escalation policy in `finalize-gen-eval` together with
   * {@link escalatedToModel}. Together they record that the task escalated exactly once and
   * also serve as the cap — both fields are checked before a second escalation can fire.
   */
  readonly escalatedFromModel?: string;
  /**
   * Generator model id the next attempt's generator leaf must spawn with. Stamped by the
   * escalation policy in `finalize-gen-eval` when a plateau triggers a once-per-task model
   * upgrade. The generator leaf prefers this value over `settings.ai.implement.generator.model`
   * when present; the evaluator role is never affected.
   */
  readonly escalatedToModel?: string;
}

export interface TodoTask extends TaskBase {
  readonly status: 'todo';
}

export interface InProgressTask extends TaskBase {
  readonly status: 'in_progress';
}

/**
 * A done task is structurally guaranteed to carry the verified attempt that proved it done.
 * The variadic-tuple type forces `attempts` to be non-empty AND the last element to be a
 * {@link VerifiedAttempt} — TypeScript rejects any code path producing a `DoneTask` without it.
 */
export interface DoneTask extends Omit<TaskBase, 'attempts'> {
  readonly status: 'done';
  readonly attempts: readonly [...Attempt[], VerifiedAttempt];
  /** 1-indexed pointer into `attempts` — `attempts[finalAttemptN - 1]` is the verified one. */
  readonly finalAttemptN: number;
}

export interface BlockedTask extends TaskBase {
  readonly status: 'blocked';
  readonly blockedReason: string;
}

export type Task = TodoTask | InProgressTask | DoneTask | BlockedTask;

/**
 * Derived from `Task` — adding a new variant flows here automatically.
 * @public
 */
export type TaskStatus = Task['status'];

export interface TaskCreateInput {
  readonly id?: TaskId;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly VerificationCriterion[];
  readonly order: number;
  readonly ticketId: TicketId;
  readonly dependsOn?: readonly TaskId[];
  readonly repositoryId: RepositoryId;
  readonly maxAttempts?: number;
  readonly extraDimensions?: readonly string[];
  readonly externalRefs?: readonly string[];
}

export interface TaskUpdateInput {
  readonly name?: string;
  /** `null` clears the description; `undefined` keeps it. */
  readonly description?: string | null;
  readonly steps?: readonly string[];
  readonly verificationCriteria?: readonly VerificationCriterion[];
  readonly dependsOn?: readonly TaskId[];
  readonly repositoryId?: RepositoryId;
  /** `null` clears the cap; `undefined` keeps it. */
  readonly maxAttempts?: number | null;
  /** `null` clears extra dimensions; `undefined` keeps them. */
  readonly extraDimensions?: readonly string[] | null;
  /** `null` clears external refs; `undefined` keeps them. */
  readonly externalRefs?: readonly string[] | null;
}

/**
 * Domain invariant: `check === 'auto'` REQUIRES `command` to be a non-empty string.
 * `check === 'manual'` REQUIRES `command` to be absent (or empty / whitespace) — encoding a
 * shell command on a manual criterion is a planning bug that should be surfaced rather than
 * silently coerced.
 */
const validateCriteria = (
  criteria: readonly VerificationCriterion[]
): Result<readonly VerificationCriterion[], ValidationError> => {
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i];
    if (c === undefined) continue;
    if (c.check === 'auto') {
      const command = c.command;
      if (command === undefined || command.trim().length === 0) {
        return Result.error(
          new ValidationError({
            field: `task.verificationCriteria[${String(i)}].command`,
            value: command,
            message: `criterion '${c.id}' is auto-checked but has no command — auto criteria require a non-empty command`,
            hint: 'Set check: "manual" if no command applies, or fill in the command the evaluator should run.',
          })
        );
      }
    } else if (c.command !== undefined && c.command.trim().length > 0) {
      return Result.error(
        new ValidationError({
          field: `task.verificationCriteria[${String(i)}].command`,
          value: c.command,
          message: `criterion '${c.id}' is manual but carries a command — manual criteria must omit the command field`,
          hint: 'Change check to "auto" if the command is the verification, or drop the command field.',
        })
      );
    }
  }
  return Result.ok(criteria);
};

/**
 * Defensively clone the criteria array AND each entry — preserves `readonly` semantics across
 * domain boundaries and trims auto / manual commands consistently. The clone drops `command`
 * entirely on manual criteria so persisted shapes stay canonical.
 */
const cloneCriteria = (criteria: readonly VerificationCriterion[]): readonly VerificationCriterion[] =>
  criteria.map((c) => ({
    id: c.id,
    assertion: c.assertion,
    check: c.check,
    ...(c.check === 'auto' && c.command !== undefined ? { command: c.command } : {}),
  }));

export const createTask = (input: TaskCreateInput): Result<TodoTask, ValidationError> => {
  const name = parseRequiredString('task.name', input.name);
  if (!name.ok) return Result.error(name.error);

  const order = parsePositiveInt('task.order', input.order);
  if (!order.ok) return Result.error(order.error);

  const description = parseOptionalString('task.description', input.description);
  if (!description.ok) return Result.error(description.error);

  let maxAttempts: number | undefined;
  if (input.maxAttempts !== undefined) {
    const parsed = parsePositiveInt('task.maxAttempts', input.maxAttempts);
    if (!parsed.ok) return Result.error(parsed.error);
    maxAttempts = parsed.value;
  }

  const criteria = validateCriteria(input.verificationCriteria);
  if (!criteria.ok) return Result.error(criteria.error);

  return Result.ok({
    id: input.id ?? TaskId.generate(),
    name: name.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    steps: [...input.steps],
    verificationCriteria: cloneCriteria(criteria.value),
    status: 'todo',
    order: order.value,
    ticketId: input.ticketId,
    dependsOn: input.dependsOn === undefined ? [] : [...input.dependsOn],
    repositoryId: input.repositoryId,
    attempts: [],
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(input.extraDimensions !== undefined ? { extraDimensions: [...input.extraDimensions] } : {}),
    ...(input.externalRefs !== undefined ? { externalRefs: [...input.externalRefs] } : {}),
  });
};

// ───────────────────────── attempt-driven transitions ─────────────────────────

const lastAttempt = (task: Task): Attempt | undefined => task.attempts[task.attempts.length - 1];

/**
 * Append a fresh `running` attempt and transition to `in_progress`. Idempotent only on a
 * fresh task — if the current last attempt is already `running`, callers must settle it first
 * via `markTaskDone` or `failCurrentAttempt`. A `done`/`blocked` task is rejected.
 *
 * Pass `recovering` when this attempt is opening as a resume of a prior aborted attempt;
 * the value is stamped onto the new `RunningAttempt` so the TUI can render the
 * resume-from-aborted banner without walking the attempt history.
 */
export const startNextAttempt = (
  task: Task,
  now: IsoTimestamp,
  sessionId?: string,
  recovering?: RecoveryContext
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'start-next-attempt',
    'Only `todo` or `in_progress` tasks can start a new attempt.'
  );
  if (!guard.ok) return Result.error(guard.error);

  const last = lastAttempt(guard.value);
  if (last !== undefined && last.status === 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: guard.value.status,
        attemptedAction: 'start-next-attempt',
        message: `task '${guard.value.id}' already has a running attempt n=${last.n}`,
        hint: 'Settle it via markTaskDone or failCurrentAttempt before starting another.',
      })
    );
  }

  const attemptInput: {
    n: number;
    startedAt: IsoTimestamp;
    sessionId?: string;
    recovering?: RecoveryContext;
  } = {
    n: guard.value.attempts.length + 1,
    startedAt: now,
  };
  if (sessionId !== undefined) attemptInput.sessionId = sessionId;
  if (recovering !== undefined) attemptInput.recovering = recovering;
  const attemptResult = startAttempt(attemptInput);
  if (!attemptResult.ok) return Result.error(attemptResult.error);

  return Result.ok({
    ...guard.value,
    status: 'in_progress',
    attempts: [...guard.value.attempts, attemptResult.value],
  });
};

const requireRunningAttempt = (
  task: InProgressTask
): Result<
  { readonly task: InProgressTask; readonly running: RunningAttempt; readonly idx: number },
  InvalidStateError
> => {
  const idx = task.attempts.length - 1;
  const last = task.attempts[idx];
  if (last === undefined || last.status !== 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'record-attempt',
        message: `task '${task.id}' has no running attempt to record into`,
        hint: 'Call startNextAttempt before recording.',
      })
    );
  }
  return Result.ok({ task, running: last, idx });
};

const replaceLastAttempt = (task: InProgressTask, attempt: Attempt): InProgressTask => {
  const next = [...task.attempts];
  next[task.attempts.length - 1] = attempt;
  return { ...task, attempts: next };
};

export const recordRunningAttemptVerification = (task: InProgressTask): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptVerification(guard.value.running)));
};

export const recordRunningAttemptEvaluation = (
  task: InProgressTask,
  evaluation: Evaluation
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptEvaluation(guard.value.running, evaluation)));
};

export const recordRunningAttemptCritique = (
  task: InProgressTask,
  text: string
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  const parsed = parseRequiredString('attempt.critique', text);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptCritique(guard.value.running, parsed.value)));
};

export const recordRunningAttemptCommit = (
  task: InProgressTask,
  sha: CommitSha
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptCommit(guard.value.running, sha)));
};

/**
 * Stamp a structured `AttemptWarning` onto the running attempt. Used by:
 *   - `gen-eval-loop` when the inner loop terminates with budget-exhausted / plateau / malformed
 *   - `post-task-verify` when the verify script runs red after commit
 *
 * The warning travels with the attempt into `markTaskDone`. At most one warning per attempt;
 * if the inner loop emits a budget warning and verify then runs red, the verify warning
 * overwrites — the more recent failure is the one the operator should see first.
 */
export const recordRunningAttemptWarning = (
  task: InProgressTask,
  warning: AttemptWarning
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptWarning(guard.value.running, warning)));
};

/**
 * Append a {@link VerifyRun} row to the running attempt's audit array. Used by the harness
 * pre/post verify-script leaves to persist deterministic verification results independent of
 * the AI's `task-verified` self-report.
 */
export const appendAttemptVerifyRun = (
  task: InProgressTask,
  run: VerifyRun
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, appendVerifyRun(guard.value.running, run)));
};

/**
 * Stamp the {@link Attribution} verdict on the running attempt. Set by post-task-verify after
 * comparing the pre and post verify-script outcomes.
 */
export const setAttemptAttribution = (
  task: InProgressTask,
  attribution: Attribution
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, setAttribution(guard.value.running, attribution)));
};

/**
 * Set the running attempt's `baselineBroken` flag — pre-task-verify ran red before the AI got
 * a chance to run, so a downstream red verdict may not be the AI's fault.
 */
export const markAttemptBaselineBroken = (task: InProgressTask): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, markBaselineBroken(guard.value.running)));
};

/**
 * Settle the current attempt as `verified` and transition the task to `done`. Requires the
 * running attempt to carry a `Verification` (call `recordRunningAttemptVerification` first).
 * `finalAttemptN` points at the verified attempt for cheap lookup.
 */
export const markTaskDone = (task: Task, now: IsoTimestamp): Result<DoneTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'mark-done',
    'Only `in_progress` tasks can be marked done.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const inner = requireRunningAttempt(guard.value);
  if (!inner.ok) return Result.error(inner.error);
  const verifiedResult = completeAttempt(inner.value.running, 'verified', now);
  if (!verifiedResult.ok) return Result.error(verifiedResult.error);
  const verified = verifiedResult.value as VerifiedAttempt;

  const head = guard.value.attempts.slice(0, inner.value.idx);
  const attempts = [...head, verified] as readonly [...Attempt[], VerifiedAttempt];

  return Result.ok({
    id: guard.value.id,
    name: guard.value.name,
    ...(guard.value.description !== undefined ? { description: guard.value.description } : {}),
    steps: guard.value.steps,
    verificationCriteria: guard.value.verificationCriteria,
    order: guard.value.order,
    ticketId: guard.value.ticketId,
    dependsOn: guard.value.dependsOn,
    repositoryId: guard.value.repositoryId,
    ...(guard.value.maxAttempts !== undefined ? { maxAttempts: guard.value.maxAttempts } : {}),
    ...(guard.value.extraDimensions !== undefined ? { extraDimensions: guard.value.extraDimensions } : {}),
    ...(guard.value.externalRefs !== undefined ? { externalRefs: guard.value.externalRefs } : {}),
    ...(guard.value.escalatedFromModel !== undefined ? { escalatedFromModel: guard.value.escalatedFromModel } : {}),
    ...(guard.value.escalatedToModel !== undefined ? { escalatedToModel: guard.value.escalatedToModel } : {}),
    status: 'done',
    attempts,
    finalAttemptN: verified.n,
  });
};

/**
 * Settle the current attempt as `failed`/`malformed`/`aborted`. If `maxAttempts` is set and
 * reached, transitions the task to `blocked` with reason `'attempt budget exhausted'`. Otherwise
 * the task stays `in_progress` and the caller can `startNextAttempt` again.
 *
 * The optional `abortMeta` is forwarded to {@link completeAttempt} — meaningful only when
 * `reason === 'aborted'`. The `start-attempt` use case supplies it on the resume path so the
 * leftover running attempt carries `abortCause` + (optional) `signalOrExitCode` into history.
 */
export const failCurrentAttempt = (
  task: Task,
  now: IsoTimestamp,
  reason: 'failed' | 'malformed' | 'aborted',
  abortMeta?: AbortMetadata
): Result<InProgressTask | BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'fail-current-attempt',
    'Only `in_progress` tasks have a current attempt to fail.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const inner = requireRunningAttempt(guard.value);
  if (!inner.ok) return Result.error(inner.error);
  const settledResult = completeAttempt(inner.value.running, reason, now, abortMeta);
  if (!settledResult.ok) return Result.error(settledResult.error);

  const inProgressNext: InProgressTask = replaceLastAttempt(guard.value, settledResult.value);
  if (guard.value.maxAttempts !== undefined && inProgressNext.attempts.length >= guard.value.maxAttempts) {
    const blocked: BlockedTask = {
      ...inProgressNext,
      status: 'blocked',
      blockedReason: `attempt budget exhausted (maxAttempts=${guard.value.maxAttempts})`,
    };
    return Result.ok(blocked);
  }
  return Result.ok(inProgressNext);
};

/**
 * Stamp the once-per-task generator model escalation onto an `in_progress` task. The fields are
 * write-once: a task that already carries either side is rejected so the escalation cap is
 * enforced at the domain layer rather than every caller re-deriving the check.
 */
export const recordTaskEscalation = (
  task: InProgressTask,
  fromModel: string,
  toModel: string
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  if (task.escalatedFromModel !== undefined || task.escalatedToModel !== undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'record-escalation',
        message: `task '${task.id}' already escalated (${String(task.escalatedFromModel)} → ${String(task.escalatedToModel)})`,
        hint: 'The once-per-task cap blocks a second escalation; transition to blocked instead.',
      })
    );
  }
  const from = parseRequiredString('task.escalatedFromModel', fromModel);
  if (!from.ok) return Result.error(from.error);
  const to = parseRequiredString('task.escalatedToModel', toModel);
  if (!to.ok) return Result.error(to.error);
  return Result.ok({ ...task, escalatedFromModel: from.value, escalatedToModel: to.value });
};

// ───────────────────────── manual lifecycle transitions ─────────────────────────

export const markTaskBlocked = (task: Task, reason: string): Result<BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'mark-blocked',
    'Done or already-blocked tasks cannot be re-blocked.'
  );
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok({ ...guard.value, status: 'blocked', blockedReason: reason });
};

export const unblockTask = (task: Task): Result<TodoTask, InvalidStateError> => {
  const guard = requireStatus('task', task, ['blocked'] as const, 'unblock');
  if (!guard.ok) return Result.error(guard.error);
  const { blockedReason: _ignored, ...rest } = guard.value;
  void _ignored;
  return Result.ok({ ...rest, status: 'todo' });
};

/**
 * Reset stale `in_progress` back to `todo` (for crash recovery). Requires there to be no
 * unsettled running attempt — call `failCurrentAttempt(..., 'aborted')` first to settle it.
 */
export const resetTaskToTodo = (task: Task): Result<TodoTask, InvalidStateError> => {
  if (task.status === 'todo') return Result.ok(task);
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'reset-to-todo',
    'Only `in_progress` tasks can be reset to todo.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const last = lastAttempt(guard.value);
  if (last !== undefined && last.status === 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'reset-to-todo',
        message: `task '${guard.value.id}' has a running attempt n=${last.n}`,
        hint: 'Settle the attempt via failCurrentAttempt(..., "aborted") before resetting.',
      })
    );
  }
  return Result.ok({ ...guard.value, status: 'todo' });
};

/**
 * Edit mutable fields. Locked once running — only `todo` tasks. `description`,
 * `extraDimensions`, and `maxAttempts` accept `null` as explicit "clear".
 */
export const updateTask = (
  task: Task,
  input: TaskUpdateInput
): Result<TodoTask, ValidationError | InvalidStateError> => {
  const guard = requireStatus('task', task, ['todo'] as const, 'update');
  if (!guard.ok) return Result.error(guard.error);
  const todo = guard.value;

  let nextName = todo.name;
  if (input.name !== undefined) {
    const parsed = parseRequiredString('task.name', input.name);
    if (!parsed.ok) return Result.error(parsed.error);
    nextName = parsed.value;
  }

  let nextDescription = todo.description;
  if (input.description !== undefined) {
    if (input.description === null) {
      nextDescription = undefined;
    } else {
      const parsed = parseOptionalString('task.description', input.description);
      if (!parsed.ok) return Result.error(parsed.error);
      nextDescription = parsed.value;
    }
  }

  let nextMaxAttempts = todo.maxAttempts;
  if (input.maxAttempts !== undefined) {
    if (input.maxAttempts === null) {
      nextMaxAttempts = undefined;
    } else {
      const parsed = parsePositiveInt('task.maxAttempts', input.maxAttempts);
      if (!parsed.ok) return Result.error(parsed.error);
      nextMaxAttempts = parsed.value;
    }
  }

  let nextExtraDimensions = todo.extraDimensions;
  if (input.extraDimensions !== undefined) {
    nextExtraDimensions = input.extraDimensions === null ? undefined : [...input.extraDimensions];
  }

  let nextExternalRefs = todo.externalRefs;
  if (input.externalRefs !== undefined) {
    nextExternalRefs = input.externalRefs === null ? undefined : [...input.externalRefs];
  }

  let nextCriteria = todo.verificationCriteria;
  if (input.verificationCriteria !== undefined) {
    const validated = validateCriteria(input.verificationCriteria);
    if (!validated.ok) return Result.error(validated.error);
    nextCriteria = cloneCriteria(validated.value);
  }

  const {
    description: _dropDesc,
    maxAttempts: _dropMax,
    extraDimensions: _dropExtra,
    externalRefs: _dropRefs,
    ...rest
  } = todo;
  void _dropDesc;
  void _dropMax;
  void _dropExtra;
  void _dropRefs;
  return Result.ok({
    ...rest,
    name: nextName,
    ...(nextDescription !== undefined ? { description: nextDescription } : {}),
    steps: input.steps !== undefined ? [...input.steps] : todo.steps,
    verificationCriteria: nextCriteria,
    dependsOn: input.dependsOn !== undefined ? [...input.dependsOn] : todo.dependsOn,
    repositoryId: input.repositoryId ?? todo.repositoryId,
    ...(nextMaxAttempts !== undefined ? { maxAttempts: nextMaxAttempts } : {}),
    ...(nextExtraDimensions !== undefined ? { extraDimensions: nextExtraDimensions } : {}),
    ...(nextExternalRefs !== undefined ? { externalRefs: nextExternalRefs } : {}),
  });
};

// ───────────────────────── dependencies ─────────────────────────

/**
 * Replace `dependsOn`. Rejects self-edges; deeper cycle detection (A→B→A) needs the
 * full task graph and lives in {@link validateTaskGraph} below.
 * @public
 */
export const setTaskDependsOn = (task: Task, deps: readonly TaskId[]): Result<Task, ValidationError> => {
  if (deps.includes(task.id)) {
    return Result.error(
      new ValidationError({
        field: 'task.dependsOn',
        value: deps,
        message: `task '${task.id}' cannot depend on itself`,
      })
    );
  }
  return Result.ok({ ...task, dependsOn: [...deps] });
};

// ───────────────────────── graph queries ─────────────────────────

/**
 * Walk the attempt history (newest → oldest) and return the most recent non-empty `critique`.
 *
 * Within a single attempt the loop's most recent evaluator turn stamps `critique` on the
 * running attempt; this query returns immediately on a match there. Across attempts (after a
 * crash + resume where `start-attempt` settles the prior running attempt as `aborted` and
 * opens a fresh one) the walk-back surfaces the prior aborted attempt's critique so the new
 * attempt's first generator turn starts with full context instead of cold.
 *
 * Returns `undefined` when no attempt has a non-empty critique — e.g. a brand-new task on its
 * very first turn, or a chain that crashed before any evaluator turn ran.
 */
export const latestCritique = (task: Task): string | undefined => {
  for (let i = task.attempts.length - 1; i >= 0; i--) {
    const att = task.attempts[i];
    if (att?.critique !== undefined && att.critique.trim().length > 0) return att.critique;
  }
  return undefined;
};

/**
 * Return the next task ready to execute: `todo` status, all `dependsOn` are `done`, picked by
 * lowest `order` to break ties deterministically. Returns `undefined` when nothing is ready
 * (either everything's done, or remaining todos are gated by unfinished deps / blocks).
 *
 * Pure — does not mutate. Caller persists the chosen task's `startNextAttempt` transition.
 */
export const nextAvailableTask = (tasks: readonly Task[]): Task | undefined => {
  const byId = new Map<TaskId, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const ready = tasks.filter((t) => {
    if (t.status !== 'todo') return false;
    return t.dependsOn.every((depId) => {
      const dep = byId.get(depId);
      return dep !== undefined && dep.status === 'done';
    });
  });

  if (ready.length === 0) return undefined;

  return ready.reduce((best, t) => (t.order < best.order ? t : best));
};

/** Issue surfaced by {@link validateTaskGraph}. */
export type TaskGraphIssue =
  | { readonly kind: 'unknown-dependency'; readonly task: TaskId; readonly missing: TaskId }
  | { readonly kind: 'self-edge'; readonly task: TaskId }
  | { readonly kind: 'cycle'; readonly cycle: readonly TaskId[] };

/**
 * Validate the dependency graph for a sprint's task set:
 *  - every `dependsOn` id resolves to a task in this set
 *  - no self-edges
 *  - no cycles (A → B → ... → A)
 *
 * Returns `Result.ok(undefined)` when sound, otherwise the first issue found.
 */
export const validateTaskGraph = (tasks: readonly Task[]): Result<undefined, TaskGraphIssue> => {
  const byId = new Map<TaskId, Task>();
  for (const t of tasks) byId.set(t.id, t);

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) return Result.error({ kind: 'self-edge', task: t.id });
      if (!byId.has(dep)) return Result.error({ kind: 'unknown-dependency', task: t.id, missing: dep });
    }
  }

  // DFS-based cycle detection. Colors: 0 = unseen, 1 = on current stack, 2 = fully explored.
  const color = new Map<TaskId, 0 | 1 | 2>();
  for (const t of tasks) color.set(t.id, 0);

  const stack: TaskId[] = [];
  const dfs = (id: TaskId): readonly TaskId[] | undefined => {
    color.set(id, 1);
    stack.push(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dep of node.dependsOn) {
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          const start = stack.indexOf(dep);
          return [...stack.slice(start), dep];
        }
        if (c === 0) {
          const cycle = dfs(dep);
          if (cycle !== undefined) return cycle;
        }
      }
    }
    stack.pop();
    color.set(id, 2);
    return undefined;
  };

  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const cycle = dfs(t.id);
      if (cycle !== undefined) return Result.error({ kind: 'cycle', cycle });
    }
  }

  return Result.ok(undefined);
};
