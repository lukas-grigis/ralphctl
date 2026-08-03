import { Result } from '@src/domain/result.ts';
import type {
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  TodoTask,
  VerificationCriterion,
} from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { parseOptionalString } from '@src/domain/value/parsers/parse-optional-string.ts';
import { parsePositiveInt } from '@src/domain/value/parsers/parse-positive-int.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { type InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

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

/** The optional `TodoTask` fields an update may drop entirely by passing `null`. */
type ClearableTaskField = 'description' | 'maxAttempts' | 'extraDimensions' | 'externalRefs';

/**
 * Return `task` without `field`. Clearing removes the key rather than setting it to `undefined`
 * so the persisted shape stays canonical (`exactOptionalPropertyTypes` forbids the latter anyway).
 * Written as one destructure per field because the omitted key must be statically known.
 */
const clearTaskField = (task: TodoTask, field: ClearableTaskField): TodoTask => {
  switch (field) {
    case 'description': {
      const { description: _cleared, ...rest } = task;
      void _cleared;
      return rest;
    }
    case 'maxAttempts': {
      const { maxAttempts: _cleared, ...rest } = task;
      void _cleared;
      return rest;
    }
    case 'extraDimensions': {
      const { extraDimensions: _cleared, ...rest } = task;
      void _cleared;
      return rest;
    }
    case 'externalRefs': {
      const { externalRefs: _cleared, ...rest } = task;
      void _cleared;
      return rest;
    }
  }
};

const setTaskName = (task: TodoTask, value: string): Result<TodoTask, ValidationError> => {
  const parsed = parseRequiredString('task.name', value);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...task, name: parsed.value });
};

/** `null` clears; a blank string parses to "absent" and clears too. */
const setTaskDescription = (task: TodoTask, value: string | null): Result<TodoTask, ValidationError> => {
  if (value === null) return Result.ok(clearTaskField(task, 'description'));
  const parsed = parseOptionalString('task.description', value);
  if (!parsed.ok) return Result.error(parsed.error);
  const next = parsed.value;
  if (next === undefined) return Result.ok(clearTaskField(task, 'description'));
  return Result.ok({ ...task, description: next });
};

const setTaskSteps = (task: TodoTask, value: readonly string[]): Result<TodoTask, ValidationError> =>
  Result.ok({ ...task, steps: [...value] });

const setTaskVerificationCriteria = (
  task: TodoTask,
  value: readonly VerificationCriterion[]
): Result<TodoTask, ValidationError> => {
  const validated = validateCriteria(value);
  if (!validated.ok) return Result.error(validated.error);
  return Result.ok({ ...task, verificationCriteria: cloneCriteria(validated.value) });
};

const setTaskDependsOn = (task: TodoTask, value: readonly TaskId[]): Result<TodoTask, ValidationError> =>
  Result.ok({ ...task, dependsOn: [...value] });

const setTaskRepositoryId = (task: TodoTask, value: RepositoryId): Result<TodoTask, ValidationError> =>
  Result.ok({ ...task, repositoryId: value });

/** `null` clears the cap; any other value must be a positive integer. */
const setTaskMaxAttempts = (task: TodoTask, value: number | null): Result<TodoTask, ValidationError> => {
  if (value === null) return Result.ok(clearTaskField(task, 'maxAttempts'));
  const parsed = parsePositiveInt('task.maxAttempts', value);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...task, maxAttempts: parsed.value });
};

/** `null` clears the extra evaluation dimensions. */
const setTaskExtraDimensions = (task: TodoTask, value: readonly string[] | null): Result<TodoTask, ValidationError> =>
  Result.ok(value === null ? clearTaskField(task, 'extraDimensions') : { ...task, extraDimensions: [...value] });

/** `null` clears the inherited external tracker references. */
const setTaskExternalRefs = (task: TodoTask, value: readonly string[] | null): Result<TodoTask, ValidationError> =>
  Result.ok(value === null ? clearTaskField(task, 'externalRefs') : { ...task, externalRefs: [...value] });

/** One field's contribution to an update: applies `input`'s value when supplied, else passes through. */
type TaskUpdateStep = (task: TodoTask, input: TaskUpdateInput) => Result<TodoTask, ValidationError>;

/**
 * Build the {@link TaskUpdateStep} for a single field. `key` and `setter` are correlated at the
 * call site (this generic invocation), so the returned closure is safe to store alongside the
 * other fields' closures in a plain, uniformly-typed array — see {@link TASK_UPDATE_STEPS}.
 *
 * `undefined` means "leave this field alone" across the whole of {@link TaskUpdateInput}, so the
 * guard is a value check rather than a `key in input` check: passing an explicit `undefined` is
 * indistinguishable from omitting the key, and both keep the current value.
 */
const taskUpdateStep = <K extends keyof TaskUpdateInput>(
  key: K,
  setter: (task: TodoTask, value: Exclude<TaskUpdateInput[K], undefined>) => Result<TodoTask, ValidationError>
): TaskUpdateStep => {
  return (task, input) => {
    const value = input[key];
    if (value === undefined) return Result.ok(task);
    return setter(task, value as Exclude<TaskUpdateInput[K], undefined>);
  };
};

/**
 * Every editable field, in the order an update applies them. Order is observable only through
 * which validation error surfaces first when an input is invalid on several fields at once, so it
 * matches the order the fields have always been validated in: name, description, cap, dimensions,
 * refs, criteria, then the three fields that carry no validation of their own.
 */
const TASK_UPDATE_STEPS: readonly TaskUpdateStep[] = [
  taskUpdateStep('name', setTaskName),
  taskUpdateStep('description', setTaskDescription),
  taskUpdateStep('maxAttempts', setTaskMaxAttempts),
  taskUpdateStep('extraDimensions', setTaskExtraDimensions),
  taskUpdateStep('externalRefs', setTaskExternalRefs),
  taskUpdateStep('verificationCriteria', setTaskVerificationCriteria),
  taskUpdateStep('steps', setTaskSteps),
  taskUpdateStep('dependsOn', setTaskDependsOn),
  taskUpdateStep('repositoryId', setTaskRepositoryId),
];

/**
 * Edit mutable fields. Locked once running — only `todo` tasks. `description`,
 * `extraDimensions`, `externalRefs`, and `maxAttempts` accept `null` as explicit "clear".
 */
export const updateTask = (
  task: Task,
  input: TaskUpdateInput
): Result<TodoTask, ValidationError | InvalidStateError> => {
  const guard = requireStatus('task', task, ['todo'] as const, 'update');
  if (!guard.ok) return Result.error(guard.error);

  let updated = guard.value;
  for (const step of TASK_UPDATE_STEPS) {
    const applied = step(updated, input);
    if (!applied.ok) return Result.error(applied.error);
    updated = applied.value;
  }
  return Result.ok(updated);
};
