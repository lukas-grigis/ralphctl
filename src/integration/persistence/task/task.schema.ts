import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { BLOCKED_UPSTREAM_REASON_PREFIX } from '@src/domain/entity/task-lifecycle.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { RepositoryIdSchema, TaskIdSchema, TicketIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { AttemptSchema } from '@src/integration/persistence/task/attempt.schema.ts';
import { TASKS_FILE_SCHEMA_VERSION, tasksFileMigrations } from '@src/integration/persistence/task/migrations.ts';
import { runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';
import { safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Structured verification-criterion shape. Mirrors {@link VerificationCriterion} in the
 * domain. The `auto` / `manual` discriminator is encoded as a literal union plus a
 * `superRefine` invariant: `auto` REQUIRES `command`, `manual` REJECTS it.
 *
 * Backwards compatibility: persisted `tasks.json` files written before this redesign carried
 * `verificationCriteria` as `string[]`. Pre-validation, the union below accepts either a bare
 * string OR the structured object; the `.transform()` step normalises strings to
 * `{ id: 'C${i+1}', assertion: <string>, check: 'manual' }`. The on-disk migration to v2
 * additionally rewrites the persisted shape so reads stop paying the normalisation cost on
 * the next save.
 */
const VerificationCriterionObject = z
  .object({
    id: z.string().min(1),
    assertion: z.string().min(1),
    check: z.union([z.literal('auto'), z.literal('manual')]),
    command: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.check === 'auto') {
      if (c.command === undefined || c.command.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `criterion '${c.id}' is auto but has no command`,
          path: ['command'],
        });
      }
    } else if (c.command !== undefined && c.command.trim().length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `criterion '${c.id}' is manual but carries a command`,
        path: ['command'],
      });
    }
  });

/**
 * Read-time normalizer — accepts the legacy `string[]` shape and rewrites each entry as
 * `{ id: 'C${i+1}', assertion: <str>, check: 'manual' }`. Already-structured arrays pass
 * through unchanged. Position-based id is the only stable choice when migrating legacy data
 * (the AI didn't tag entries pre-redesign).
 */
const VerificationCriteriaSchema = z.array(z.union([z.string().min(1), VerificationCriterionObject])).transform((arr) =>
  arr.map((entry, i) => {
    if (typeof entry === 'string') {
      return { id: `C${String(i + 1)}`, assertion: entry, check: 'manual' as const };
    }
    return entry;
  })
);

const TaskBaseShape = {
  id: TaskIdSchema,
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).readonly(),
  verificationCriteria: VerificationCriteriaSchema,
  order: z.number(),
  ticketId: TicketIdSchema,
  dependsOn: z.array(TaskIdSchema).readonly(),
  repositoryId: RepositoryIdSchema,
  attempts: z.array(AttemptSchema).readonly(),
  maxAttempts: z.number().optional(),
  extraDimensions: z.array(z.string()).readonly().optional(),
  externalRefs: z.array(z.string()).readonly().optional(),
  escalatedFromModel: z.string().optional(),
  escalatedToModel: z.string().optional(),
};

const TodoTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('todo') });
const InProgressTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('in_progress') });

/**
 * `blockKind` is the structural discriminant between an upstream-cascade block (auto-clearable)
 * and an own-failure block (operator must fix). It is OPTIONAL on read so `tasks.json` files
 * written before the field existed still load; a missing value is inferred post-parse from the
 * legacy reason prefix (see {@link inferBlockKind}). The schema member stays a plain object — a
 * `.transform()` here would make it ineligible for `z.discriminatedUnion`, so the inference runs
 * on the parsed union instead. The inferred value materialises into the loaded entity, so the
 * canonical shape lands on the next save.
 */
const BlockedTaskSchema = z.object({
  ...TaskBaseShape,
  status: z.literal('blocked'),
  blockedReason: z.string(),
  blockKind: z.union([z.literal('upstream'), z.literal('own')]).optional(),
});

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

const TaskBaseUnionSchema = z.discriminatedUnion('status', [
  TodoTaskSchema,
  InProgressTaskSchema,
  BlockedTaskSchema,
  DoneTaskSchema,
]);

/** The raw, pre-transform inferred union — a `blocked` member still carries `blockKind?`. */
type RawParsedTask = z.infer<typeof TaskBaseUnionSchema>;

/**
 * The transform's output type. Identical to {@link RawParsedTask} except the `blocked` member's
 * `blockKind` is REQUIRED `'upstream' | 'own'` — `inferBlockKind` always materialises it. Narrowing
 * the branch here (rather than leaving the inferred optional) means `TaskSchema`'s output already
 * matches the domain `BlockedTask`, so `fromJsonTask` no longer needs to cast over an optional→required
 * gap on `blockKind`. (The remaining cast is purely about the `DoneTask` attempts tuple — see below.)
 */
type ParsedTask =
  | Exclude<RawParsedTask, { status: 'blocked' }>
  | (Extract<RawParsedTask, { status: 'blocked' }> & { blockKind: 'upstream' | 'own' });

/**
 * Read-time inference for a `blocked` task that predates {@link BlockedTask.blockKind}: a reason
 * starting with the (deprecated) `blocked upstream` prefix is an upstream-cascade block, everything
 * else is an own-failure block. Runs post-union so the discriminated-union members stay plain
 * objects (a transform on the member would break discrimination). Returns {@link ParsedTask}, whose
 * `blocked` branch declares `blockKind` as required — every code path through here sets it.
 */
const inferBlockKind = (task: RawParsedTask): ParsedTask => {
  if (task.status !== 'blocked') return task;
  return {
    ...task,
    blockKind: task.blockKind ?? (task.blockedReason.startsWith(BLOCKED_UPSTREAM_REASON_PREFIX) ? 'upstream' : 'own'),
  };
};

export const TaskSchema = TaskBaseUnionSchema.transform(inferBlockKind);

/**
 * `TaskSchema` already infers a `blocked` task's `blockKind` as the required `'upstream' | 'own'`
 * (the transform narrows it), so the only residual gap versus the domain `Task` is the `DoneTask`
 * attempts tuple: the schema infers `attempts: readonly Attempt[]` but `DoneTask` declares the
 * stricter `readonly [...Attempt[], VerifiedAttempt]`. The narrowed `value as Task` cast bridges
 * exactly that tuple gap and is sound because `DoneTaskSchema`'s `superRefine` validates the same
 * invariant at runtime; the `blockKind` optional→required gap that previously forced a wider cast
 * over the whole `Result` is gone.
 */
export const fromJsonTask = (input: unknown): Result<Task, ParseError> => {
  const parsed = safeParseToResult<ParsedTask, typeof TaskSchema>(TaskSchema, input);
  if (!parsed.ok) return parsed;
  return Result.ok(parsed.value as Task);
};

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
    TasksFileSchema,
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
