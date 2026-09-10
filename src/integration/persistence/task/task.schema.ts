import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import type { BlockCause, FaultSide, Task } from '@src/domain/entity/task.ts';
import type { TaskBlockerClass } from '@src/domain/signal.ts';
import { BLOCKED_UPSTREAM_REASON_PREFIX, classifyBlock } from '@src/domain/entity/task-lifecycle.ts';
import type { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { RepositoryIdSchema, TaskIdSchema, TicketIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { AttemptSchema } from '@src/integration/persistence/task/attempt.schema.ts';
import { TASKS_FILE_SCHEMA_VERSION, tasksFileMigrations } from '@src/integration/persistence/task/migrations.ts';
import { runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

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

/**
 * Harness-owned per-criterion verdict map — keyed by criterion id, valued by the durable
 * PASS / FAIL / UNKNOWN state. Optional on read so `tasks.json` files written before the field
 * existed still load (a missing value heals to `undefined`); folded at settle time, never set by
 * the planner.
 */
const CriteriaVerdictsSchema = z
  .record(z.string(), z.union([z.literal('passed'), z.literal('failed'), z.literal('unknown')]))
  .optional();

/**
 * One archived block → unblock cycle. Mirrors {@link RetiredRun} in the domain — the attempts,
 * per-criterion verdicts and escalation stamps `unblockTask` clears off the live task fields for a
 * clean restart, kept here instead of deleted. Every field beyond `attempts` reuses the same
 * schema (and the same tolerant-read rationale) as its live counterpart below.
 */
const RetiredRunSchema = z.object({
  attempts: z.array(AttemptSchema).readonly(),
  criteriaVerdicts: CriteriaVerdictsSchema,
  escalatedFromModel: z.string().optional(),
  escalatedToModel: z.string().optional(),
  escalatedToEffort: z.string().optional(),
  escalatedToEvaluatorEffort: z.string().optional(),
});

const TaskBaseShape = {
  id: TaskIdSchema,
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).readonly(),
  verificationCriteria: VerificationCriteriaSchema,
  criteriaVerdicts: CriteriaVerdictsSchema,
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
  // Same-model effort-rung override. Optional on read so `tasks.json` files written before the
  // field existed load unchanged (a missing value heals to `undefined`). Never planner-authored.
  escalatedToEffort: z.string().optional(),
  // Evaluator-side counterpart of escalatedToEffort — same tolerant-read rationale. The evaluator
  // MODEL never escalates, so there is no evaluator equivalent of escalatedToModel.
  escalatedToEvaluatorEffort: z.string().optional(),
  // Best-of-N escalation grant — same tolerant-read rationale as the escalation fields above.
  // `bestOfNGranted` is the permanent once-per-task marker; `bestOfNGrantedCandidates` is the
  // transient candidate count the attempt-body consumes. Both optional so `tasks.json` files
  // written before the fields existed still load.
  bestOfNGranted: z.literal(true).optional(),
  bestOfNGrantedCandidates: z.number().optional(),
  // Archive of retired (unblock-cleared) runs — see `RetiredRunSchema`. Optional on read so
  // `tasks.json` files written before `unblockTask` archived instead of deleted still load
  // unchanged (a missing value heals to `undefined`); no migration pass required.
  retiredAttempts: z.array(RetiredRunSchema).readonly().optional(),
};

const TodoTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('todo') });
const InProgressTaskSchema = z.object({ ...TaskBaseShape, status: z.literal('in_progress') });

/**
 * Mirrors the domain {@link BlockCause} closed enum exactly — the `Compatible` check below the
 * schema declaration keeps them from drifting apart silently.
 */
const BlockCauseSchema = z.union([
  z.literal('upstream-dependency'),
  z.literal('generator-self-block'),
  z.literal('pre-verify-red'),
  z.literal('post-verify-regression'),
  z.literal('fold-conflict'),
  z.literal('worktree-setup-failure'),
  z.literal('operator-cancelled'),
  z.literal('budget-exhausted'),
  z.literal('unknown'),
]);

/** Mirrors the domain {@link FaultSide} closed enum exactly — same drift guard as {@link BlockCauseSchema}. */
const FaultSideSchema = z.union([
  z.literal('model'),
  z.literal('harness'),
  z.literal('environment'),
  z.literal('grader'),
  z.literal('unknown'),
]);

/**
 * Mirrors the domain {@link TaskBlockerClass} closed enum exactly — same drift guard as
 * {@link BlockCauseSchema}. Unlike `blockCause` / `faultSide`, there is no read-time inference for
 * a missing value: this is the GENERATOR's own classification, which the harness has no basis to
 * guess when the producing signal omitted it.
 */
const TaskBlockerClassSchema = z.union([
  z.literal('missing-information'),
  z.literal('ambiguous-request'),
  z.literal('contradictory-information'),
]);

const _blockCauseCheck: Compatible<z.infer<typeof BlockCauseSchema>, BlockCause> = true;
void _blockCauseCheck;
const _faultSideCheck: Compatible<z.infer<typeof FaultSideSchema>, FaultSide> = true;
void _faultSideCheck;
const _blockerClassCheck: Compatible<z.infer<typeof TaskBlockerClassSchema>, TaskBlockerClass> = true;
void _blockerClassCheck;

/**
 * `blockKind` is the structural discriminant between an upstream-cascade block (auto-clearable)
 * and an own-failure block (operator must fix). `blockCause` / `faultSide` refine it further (see
 * `domain/entity/task.ts`). All three are OPTIONAL on read so `tasks.json` files written before the
 * fields existed still load; missing values are inferred post-parse (see {@link inferBlockKind},
 * which now classifies all three together via the domain's own `classifyBlock`). The schema member
 * stays a plain object — a `.transform()` here would make it ineligible for `z.discriminatedUnion`,
 * so the inference runs on the parsed union instead. The inferred values materialise into the
 * loaded entity, so the canonical shape lands on the next save.
 */
const BlockedTaskSchema = z.object({
  ...TaskBaseShape,
  status: z.literal('blocked'),
  blockedReason: z.string(),
  blockKind: z.union([z.literal('upstream'), z.literal('own')]).optional(),
  blockCause: BlockCauseSchema.optional(),
  faultSide: FaultSideSchema.optional(),
  // The generator's own structured triage (domain/entity/task.ts's `BlockedTask.blockerClass` /
  // `question` / `whatUnblocksMe`) — all three optional with NO inference on a missing value
  // (unlike `blockCause` / `faultSide` above): a row written before these fields existed, or a
  // self-block signal that omitted them, simply carries none of the three. Tolerant on read by
  // construction — `.optional()`, never a required field a legacy row could fail to parse against.
  blockerClass: TaskBlockerClassSchema.optional(),
  question: z.string().optional(),
  whatUnblocksMe: z.string().optional(),
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
 * `blockKind` / `blockCause` / `faultSide` are REQUIRED — `inferBlockKind` always materialises all
 * three. Narrowing the branch here (rather than leaving the inferred fields optional) means
 * `TaskSchema`'s output already matches the domain `BlockedTask`, so `fromJsonTask` no longer needs
 * to cast over an optional→required gap on them. (The remaining cast is purely about the `DoneTask`
 * attempts tuple — see below.)
 */
type ParsedTask =
  | Exclude<RawParsedTask, { status: 'blocked' }>
  | (Extract<RawParsedTask, { status: 'blocked' }> & {
      blockKind: 'upstream' | 'own';
      blockCause: BlockCause;
      faultSide: FaultSide;
    });

/**
 * Read-time inference for a `blocked` task that predates {@link BlockedTask.blockKind} /
 * `blockCause` / `faultSide`: `blockKind` still falls back to the legacy reason-prefix heuristic
 * (a reason starting with the deprecated `blocked upstream` prefix is an upstream-cascade block,
 * everything else own-failure); `blockCause` / `faultSide` are then classified together via the
 * domain's own `classifyBlock` (`task-lifecycle.ts`), which honours any values already on disk and
 * only infers what's missing — never overwrites an explicit classification a producer already
 * stamped.
 *
 * The block's own reason text can't always tell a crash-driven attempt-budget exhaustion from a
 * genuine quality plateau — a caller outside this module's ownership (`start-attempt.ts`'s resume
 * recovery) settles the LAST attempt as `aborted` with real crash forensics but blocks the task via
 * a plain "attempt budget exhausted" literal with no text hint at all. The last attempt's own
 * `abortCause` (persisted on every attempt regardless of who wrote the block) is read here as a
 * fallback signal so that crash still overrides the text-based `model` default — the same
 * definitive-forensics-over-guess priority `classifyBlock`'s `abortCause` hint already encodes.
 *
 * Runs post-union so the discriminated-union members stay plain objects (a transform on the member
 * would break discrimination). Returns {@link ParsedTask}, whose `blocked` branch declares all
 * three fields as required — every code path through here sets them.
 */
const inferBlockKind = (task: RawParsedTask): ParsedTask => {
  if (task.status !== 'blocked') return task;
  const blockKind =
    task.blockKind ?? (task.blockedReason.startsWith(BLOCKED_UPSTREAM_REASON_PREFIX) ? 'upstream' : 'own');
  const { blockCause, faultSide } = classifyBlock(task.blockedReason, blockKind, {
    blockCause: task.blockCause,
    faultSide: task.faultSide,
    abortCause: task.attempts[task.attempts.length - 1]?.abortCause,
  });
  return { ...task, blockKind, blockCause, faultSide };
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
