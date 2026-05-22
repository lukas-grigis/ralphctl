import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { RepositoryIdSchema, TaskIdSchema, TicketIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { AttemptSchema } from '@src/integration/persistence/task/attempt.schema.ts';
import { TASKS_FILE_SCHEMA_VERSION, tasksFileMigrations } from '@src/integration/persistence/task/migrations.ts';
import { runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';
import { safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

const TaskBaseShape = {
  id: TaskIdSchema,
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).readonly(),
  verificationCriteria: z.array(z.string()).readonly(),
  order: z.number(),
  ticketId: TicketIdSchema,
  dependsOn: z.array(TaskIdSchema).readonly(),
  repositoryId: RepositoryIdSchema,
  attempts: z.array(AttemptSchema).readonly(),
  maxAttempts: z.number().optional(),
  extraDimensions: z.array(z.string()).readonly().optional(),
  externalRefs: z.array(z.string()).readonly().optional(),
};

const TodoTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('todo') });
const InProgressTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('in_progress') });
const BlockedTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('blocked'), blockedReason: z.string() });

/**
 * `DoneTask` requires the attempt at index `finalAttemptN - 1` to be a verified attempt.
 * Encoded via `superRefine` because variadic-tuple shape is awkward in zod.
 */
const DoneTaskSchema = z
  .object({
    ...TaskBaseShape,
    status: z.literal('done'),
    finalAttemptN: z.number(),
  })
  .superRefine((task, ctx) => {
    if (task.attempts.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'done task must have at least one attempt' });
      return;
    }
    if (!Number.isInteger(task.finalAttemptN) || task.finalAttemptN < 1 || task.finalAttemptN > task.attempts.length) {
      ctx.addIssue({
        code: 'custom',
        message: `finalAttemptN=${String(task.finalAttemptN)} is out of range [1..${String(task.attempts.length)}]`,
      });
      return;
    }
    const final = task.attempts[task.finalAttemptN - 1];
    if (final === undefined || final.status !== 'verified') {
      ctx.addIssue({
        code: 'custom',
        message: `attempt n=${String(task.finalAttemptN)} must have status 'verified'`,
      });
    }
  });

export const TaskSchema = z.discriminatedUnion('status', [
  TodoTaskSchema,
  InProgressTaskSchema,
  BlockedTaskSchema,
  DoneTaskSchema,
]);

/**
 * Schema infers `attempts: readonly Attempt[]` but `DoneTask` declares the stricter
 * `readonly [...Attempt[], VerifiedAttempt]` tuple. The cast is sound because `DoneTaskSchema`'s
 * `superRefine` validates the same invariant at runtime.
 */
export const fromJsonTask = (input: unknown): Result<Task, ParseError> =>
  safeParseToResult(TaskSchema, input) as Result<Task, ParseError>;

export const toJsonTask = (task: Task): unknown => task;

/**
 * Versioned envelope for `tasks.json`. The file root is `{ schemaVersion, tasks }` post-Wave-8;
 * pre-Wave-8 files used a bare `Task[]` root, which {@link tasksFileMigrations} v0 lifts into
 * this shape.
 */
const TasksFileSchema = z.object({
  schemaVersion: z.literal(TASKS_FILE_SCHEMA_VERSION).default(TASKS_FILE_SCHEMA_VERSION),
  tasks: z.array(TaskSchema).readonly(),
});

/**
 * Decode a `tasks.json` payload. Walks the per-entity migration chain forward to
 * `TASKS_FILE_SCHEMA_VERSION` (lifting the legacy bare-array root + dropping per-row
 * `stdoutTailBytes`), then Zod-parses the envelope and returns the inner `Task[]`.
 */
export const fromJsonTasksFile = (
  input: unknown,
  filePath = 'tasks.json'
): Result<readonly Task[], MigrationGapError | ParseError> => {
  const parsed = runMigrations<{ schemaVersion: typeof TASKS_FILE_SCHEMA_VERSION; tasks: readonly Task[] }>(
    input,
    TASKS_FILE_SCHEMA_VERSION,
    tasksFileMigrations,
    TasksFileSchema as unknown as z.ZodType<{
      schemaVersion: typeof TASKS_FILE_SCHEMA_VERSION;
      tasks: readonly Task[];
    }>,
    filePath
  );
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.tasks } as Result<readonly Task[], MigrationGapError | ParseError>;
};

/**
 * Wrap an in-memory `Task[]` into the versioned envelope. Old files written without
 * `schemaVersion` heal on the next save.
 */
export const toJsonTasksFile = (tasks: readonly Task[]): unknown => ({
  schemaVersion: TASKS_FILE_SCHEMA_VERSION,
  tasks: tasks.map(toJsonTask),
});
