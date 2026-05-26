import { Result } from '@src/domain/result.ts';
import type {
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  TodoTask,
  VerificationCriterion,
} from '@src/domain/entity/task.ts';
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
