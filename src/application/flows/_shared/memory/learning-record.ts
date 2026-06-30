import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { TaskKind } from '@src/business/task/derive-task-kind.ts';

/**
 * The two kinds of durable per-project memory the implement flow captures. They share ONE record
 * shape and ONE ledger file (`learnings.ndjson`), discriminated by this tag:
 *
 *  - `learning` — a generator/evaluator `<learning>` signal (the Insight). The ONLY kind the
 *    human-gated distill flow folds into a provider-native context file (CLAUDE.md / AGENTS.md / …).
 *  - `decision` — a generator `<decision>` signal (an architectural choice). Captured durably and
 *    surfaced read-only to a later sprint's generator, but NEVER auto-curated into a native file.
 *
 * A record with the field ABSENT is a legacy row written before decisions shared the ledger — it is
 * treated as a `learning` (see {@link recordKind}). New writers always stamp it explicitly.
 *
 * @public
 */
export type MemoryKind = 'learning' | 'decision';

/**
 * One durable per-project memory record — a `<learning>` OR a `<decision>` — persisted to the
 * project's append-only NDJSON ledger at `<memoryRoot>/<projectId>/learnings.ndjson`, discriminated
 * by {@link kind}.
 *
 * This is the SINGLE source of truth for the record shape. Both sides of the procedural-memory
 * pipeline import it:
 *  - the WRITE side (`appendLearningsLeaf`) constructs one record per `<learning>` / `<decision>`
 *    signal and appends it with `promotedAt: null` (and the matching `kind`);
 *  - the READ side (`loadLearningsLeaf` / `stampPromotedLeaf`) parses every line, proposes
 *    the not-yet-promoted, not-retired ones to the operator, then stamps the accepted ids
 *    `promotedAt` and the explicitly-declined ones `retiredAt`.
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
   * Stable dedup key — `sha1(repo|taskKind|[kind|]normalize(text))[:16]` (computed by the write
   * side). The read side dedups proposals by this id and stamps `promotedAt` keyed on it, so a
   * record re-emitted by a later task collapses onto the same ledger row rather than duplicating.
   * The `kind` segment is folded in for decisions only (see {@link deriveDecisionId}) so a learning
   * keeps its byte-identical legacy id while an identical sentence emitted as a decision stays
   * distinct.
   */
  readonly id: string;
  /**
   * Discriminator — `learning` or `decision`. OPTIONAL on disk for forward/backward-compat: a
   * legacy row written before decisions shared the ledger omits it and is read as a `learning`
   * (see {@link recordKind}). New writers always set it.
   */
  readonly kind?: MemoryKind | undefined;
  /** The memory prose itself — the `<learning>` / `<decision>` signal body (the Insight), verbatim. */
  readonly text: string;
  /** Optional Context — when / why the insight arose. Absent on legacy (v1) and decision rows. */
  readonly context?: string | undefined;
  /** Optional Applies-to — where it applies (repo area, task kind, subsystem). Absent on legacy / decision rows. */
  readonly appliesTo?: string | undefined;
  /** Absolute path of the repository the record was produced in. */
  readonly repo: string;
  /** Human-friendly repository name (the repo's `name`, not its path). */
  readonly repoName: string;
  /** Coarse classification of the producing task — buckets records at distillation time. */
  readonly taskKind: TaskKind;
  /** Id of the sprint whose implement run produced the record. */
  readonly sprintId: string;
  /** Id of the task that produced the record. */
  readonly taskId: string;
  /** ISO-8601 timestamp the record was appended to the ledger. */
  readonly timestamp: string;
  /**
   * ISO-8601 timestamp the learning was folded into a project context file by the distill flow,
   * or `null` while it is still a pending proposal. `loadLearningsLeaf` filters to `null`;
   * `stampPromotedLeaf` flips it to the distillation timestamp for accepted ids. Decisions are never
   * distilled, so a decision row stays `null` here for its whole life.
   */
  readonly promotedAt: string | null;
  /**
   * ISO-8601 timestamp the record was durably RETIRED, or absent/`null` while it is still live.
   * A retired record permanently leaves the prompt-injection candidate pool and is never re-proposed
   * — the durable rejection state for a learning the operator declined at the distill gate. Mirrors
   * {@link promotedAt}; OPTIONAL on disk so legacy rows (which never carried it) round-trip as "not
   * retired" (see {@link isRetired}).
   */
  readonly retiredAt?: string | null | undefined;
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
  // OPTIONAL on disk: a legacy row omits it and reads as a `learning` (see `recordKind`).
  kind: z.enum(['learning', 'decision']).optional(),
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
  // OPTIONAL + nullable: legacy rows omit it (→ "not retired"); a retired row carries the ISO stamp.
  retiredAt: z.string().nullable().optional(),
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

const sha1Of = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16);

/**
 * Derive the stable dedup id for a LEARNING — `sha1(repo|taskKind|normalize(text))` truncated to
 * 16 hex chars. This is the SINGLE definition of the learning id scheme: the WRITE side
 * (`appendLearningsLeaf`) stamps it onto each appended learning record, and the READ side
 * (`loadLearningsLeaf`) dedups proposals by the record's `id`. Because both sides agree on this
 * function, a learning re-emitted verbatim by a later task produces an identical id and collapses
 * onto one ledger row rather than duplicating.
 *
 * The `repo` and `taskKind` are folded into the key (not just `text`) so the same sentence learned
 * in two different repos — or while doing two different kinds of work — stays distinct: an
 * identical insight can carry repo- or kind-specific weight at distillation time. The `kind` is
 * deliberately NOT folded in here so a learning keeps the byte-identical id it had before decisions
 * shared the ledger (no dedup drift across the upgrade).
 *
 * @public
 */
export const deriveLearningId = (repo: string, taskKind: TaskKind, text: string): string =>
  sha1Of(`${repo}|${taskKind}|${normalizeForId(text)}`);

/**
 * Derive the stable dedup id for a DECISION. Same scheme as {@link deriveLearningId} but with a
 * `decision` segment folded into the key, so an identical sentence emitted BOTH as a learning and as
 * a decision keeps two distinct ledger rows (the shared file would otherwise collapse them onto one).
 *
 * @public
 */
export const deriveDecisionId = (repo: string, taskKind: TaskKind, text: string): string =>
  sha1Of(`${repo}|${taskKind}|decision|${normalizeForId(text)}`);

/**
 * The record's {@link MemoryKind}, defaulting a legacy row (no `kind` field) to `learning`. The
 * single place the absent-field default lives, so every consumer agrees on it.
 *
 * @public
 */
export const recordKind = (record: LearningRecord): MemoryKind => record.kind ?? 'learning';

/** True iff the record is a `learning` (or a legacy row, which defaults to `learning`). @public */
export const isLearning = (record: LearningRecord): boolean => recordKind(record) === 'learning';

/** True iff the record is a `decision`. @public */
export const isDecision = (record: LearningRecord): boolean => recordKind(record) === 'decision';

/**
 * True iff the record has been durably RETIRED (the operator declined it at the distill gate). A
 * retired record is excluded from prompt injection and never re-proposed. Tolerates both `null`
 * (explicit "not retired") and absent (legacy row) as live.
 *
 * @public
 */
export const isRetired = (record: LearningRecord): boolean =>
  record.retiredAt !== undefined && record.retiredAt !== null;
