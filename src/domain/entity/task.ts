import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import {
  type Attempt,
  type AttemptWarning,
  completeAttempt,
  type Evaluation,
  recordAttemptCommit,
  recordAttemptCritique,
  recordAttemptEvaluation,
  recordAttemptVerification,
  recordAttemptWarning,
  type RunningAttempt,
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
export type { Evaluation, EvaluationStatus, Verification } from '@src/domain/entity/attempt.ts';

interface TaskBase extends Entity<TaskId> {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly string[];
  readonly verificationCriteria: readonly string[];
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
  readonly verificationCriteria: readonly string[];
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
  readonly verificationCriteria?: readonly string[];
  readonly dependsOn?: readonly TaskId[];
  readonly repositoryId?: RepositoryId;
  /** `null` clears the cap; `undefined` keeps it. */
  readonly maxAttempts?: number | null;
  /** `null` clears extra dimensions; `undefined` keeps them. */
  readonly extraDimensions?: readonly string[] | null;
  /** `null` clears external refs; `undefined` keeps them. */
  readonly externalRefs?: readonly string[] | null;
}

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

  return Result.ok({
    id: input.id ?? TaskId.generate(),
    name: name.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    steps: [...input.steps],
    verificationCriteria: [...input.verificationCriteria],
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
 */
export const startNextAttempt = (
  task: Task,
  now: IsoTimestamp,
  sessionId?: string
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

  const attemptInput: { n: number; startedAt: IsoTimestamp; sessionId?: string } = {
    n: guard.value.attempts.length + 1,
    startedAt: now,
  };
  if (sessionId !== undefined) attemptInput.sessionId = sessionId;
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
 *   - `post-task-check` when the verify script runs red after commit
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
    status: 'done',
    attempts,
    finalAttemptN: verified.n,
  });
};

/**
 * Settle the current attempt as `failed`/`malformed`/`aborted`. If `maxAttempts` is set and
 * reached, transitions the task to `blocked` with reason `'attempt budget exhausted'`. Otherwise
 * the task stays `in_progress` and the caller can `startNextAttempt` again.
 */
export const failCurrentAttempt = (
  task: Task,
  now: IsoTimestamp,
  reason: 'failed' | 'malformed' | 'aborted'
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
  const settledResult = completeAttempt(inner.value.running, reason, now);
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
    verificationCriteria:
      input.verificationCriteria !== undefined ? [...input.verificationCriteria] : todo.verificationCriteria,
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
