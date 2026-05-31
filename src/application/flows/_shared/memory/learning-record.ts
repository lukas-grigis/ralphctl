import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { TaskKind } from '@src/business/task/derive-task-kind.ts';

/**
 * One distilled learning emitted by an implement task and persisted to the project's
 * append-only NDJSON ledger at `<memoryRoot>/<projectId>/learnings.ndjson`.
 *
 * This is the SINGLE source of truth for the record shape. Both sides of the procedural-memory
 * pipeline import it:
 *  - the WRITE side (`appendLearningsLeaf`) constructs one record per `<learning>` signal
 *    and appends it with `promotedAt: null`;
 *  - the READ side (`loadLearningsLeaf` / `stampPromotedLeaf`) parses every line, proposes
 *    the not-yet-promoted ones to the operator, then stamps the accepted ids `promotedAt`.
 *
 * Do NOT redefine these fields anywhere else — both leaves depend on the exact shape staying
 * identical so a record round-trips through the ledger untouched.
 *
 * @public
 */
export interface LearningRecord {
  /** Schema version of the record on disk. Bumped only on a breaking field change. */
  readonly v: number;
  /**
   * Stable dedup key — `sha1(repo|taskKind|normalize(text))[:16]` (computed by the write side).
   * The read side dedups proposals by this id and stamps `promotedAt` keyed on it, so a learning
   * re-emitted by a later task collapses onto the same ledger row rather than duplicating.
   */
  readonly id: string;
  /** The learning prose itself — the `<learning>` signal body (the Insight), verbatim. */
  readonly text: string;
  /** Optional Context — when / why the insight arose. Absent on legacy (v1) rows. */
  readonly context?: string | undefined;
  /** Optional Applies-to — where it applies (repo area, task kind, subsystem). Absent on legacy rows. */
  readonly appliesTo?: string | undefined;
  /** Absolute path of the repository the learning was produced in. */
  readonly repo: string;
  /** Human-friendly repository name (the repo's `name`, not its path). */
  readonly repoName: string;
  /** Coarse classification of the producing task — buckets learnings at distillation time. */
  readonly taskKind: TaskKind;
  /** Id of the sprint whose implement run produced the learning. */
  readonly sprintId: string;
  /** Id of the task that produced the learning. */
  readonly taskId: string;
  /** ISO-8601 timestamp the learning was appended to the ledger. */
  readonly timestamp: string;
  /**
   * ISO-8601 timestamp the learning was folded into a project context file by the distill flow,
   * or `null` while it is still a pending proposal. `loadLearningsLeaf` filters to `null`;
   * `stampPromotedLeaf` flips it to the distillation timestamp for accepted ids.
   */
  readonly promotedAt: string | null;
}

const taskKindSchema = z.enum(['feature', 'bugfix', 'refactor', 'test', 'docs', 'chore', 'other']);

/**
 * Zod schema for a single NDJSON line. Co-located with the interface so a drift between the two
 * surfaces at typecheck (`satisfies` below). `.strict()` is intentionally NOT used — a future
 * record may grow fields, and an older reader should tolerate (ignore) them rather than reject
 * the whole ledger line.
 *
 * @public
 */
export const learningRecordSchema = z.object({
  v: z.number().int(),
  id: z.string().min(1),
  // `text` is the required Insight. Reject empty / whitespace-only prose — a degenerate ledger
  // row carries no signal and only pollutes the distill candidate list. A `.refine` (NOT a
  // `.transform`) keeps the stored value byte-for-byte: surrounding whitespace round-trips
  // unchanged, only the presence of at least one non-whitespace character is enforced.
  text: z.string().refine((t) => t.trim().length > 0, { message: 'learning text must not be empty' }),
  context: z.string().optional(),
  appliesTo: z.string().optional(),
  repo: z.string(),
  repoName: z.string(),
  taskKind: taskKindSchema,
  sprintId: z.string(),
  taskId: z.string(),
  timestamp: z.string(),
  promotedAt: z.string().nullable(),
});

// Compile-time guard: the schema's inferred output must exactly match the interface. A field
// added to one but not the other fails typecheck here, so the two cannot silently drift.
type _SchemaMatchesInterface =
  z.infer<typeof learningRecordSchema> extends LearningRecord
    ? LearningRecord extends z.infer<typeof learningRecordSchema>
      ? true
      : never
    : never;
const _schemaMatchesInterface: _SchemaMatchesInterface = true;
void _schemaMatchesInterface;

/**
 * Parse one NDJSON line into a {@link LearningRecord}. Blank lines yield `Result.ok(undefined)`
 * (a trailing newline is normal for an append-only ledger). A malformed line yields a
 * `ParseError` carrying the offending line — the caller decides whether to skip or fail.
 *
 * @public
 */
export const parseLearningLine = (line: string): Result<LearningRecord | undefined, ParseError> => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return Result.ok(undefined);

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    return Result.error(
      new ParseError({ subCode: 'invalid-json', message: 'learnings.ndjson line is not valid JSON', cause })
    );
  }

  const parsed = learningRecordSchema.safeParse(json);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: 'learnings.ndjson line does not match the LearningRecord schema',
        cause: parsed.error,
      })
    );
  }
  return Result.ok(parsed.data);
};

/**
 * Serialize a {@link LearningRecord} to a single NDJSON line (JSON + trailing newline). The
 * inverse of {@link parseLearningLine}. Both sides of the pipeline use this so the on-disk
 * encoding is owned in one place.
 *
 * @public
 */
export const serializeLearningRecord = (record: LearningRecord): string => `${JSON.stringify(record)}\n`;

/**
 * Normalize a learning's prose for hashing. Trims surrounding whitespace, lower-cases, and
 * collapses internal runs of whitespace to a single space so two learnings that differ only by
 * incidental formatting (a trailing newline, a double space, casing) collapse onto the SAME
 * dedup id. Deliberately conservative — it does not strip punctuation, so two genuinely
 * different sentences keep distinct ids.
 */
const normalizeForId = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Derive the stable dedup id for a learning — `sha1(repo|taskKind|normalize(text))` truncated to
 * 16 hex chars. This is the SINGLE definition of the id scheme: the WRITE side
 * (`appendLearningsLeaf`) stamps it onto each appended record, and the READ side
 * (`loadLearningsLeaf`) dedups proposals by the record's `id`. Because both sides agree on this
 * function, a learning re-emitted verbatim by a later task produces an identical id and collapses
 * onto one ledger row rather than duplicating.
 *
 * The `repo` and `taskKind` are folded into the key (not just `text`) so the same sentence learned
 * in two different repos — or while doing two different kinds of work — stays distinct: an
 * identical insight can carry repo- or kind-specific weight at distillation time.
 *
 * @public
 */
export const deriveLearningId = (repo: string, taskKind: TaskKind, text: string): string =>
  createHash('sha1')
    .update(`${repo}|${taskKind}|${normalizeForId(text)}`)
    .digest('hex')
    .slice(0, 16);
