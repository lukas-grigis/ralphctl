import { hash } from 'node:crypto';
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
 */
export type MemoryKind = 'learning' | 'decision';

const taskKindSchema = z.enum(['feature', 'bugfix', 'refactor', 'test', 'docs', 'chore', 'other']);

/**
 * One line of the project's append-only `learnings.ndjson` ledger — a `<learning>` or `<decision>`
 * — shared by the write side (`appendLearningsLeaf`) and the read side (`loadLearningsLeaf` /
 * `stampPromotedLeaf`). Not `.strict()`: an older reader ignores fields a newer one adds.
 */
export const learningRecordSchema = z.object({
  /** Schema version; bumped only on a breaking field change. */
  v: z.number().int(),
  /** Stable dedup key — see {@link deriveLearningId} / {@link deriveDecisionId}. */
  id: z.string().min(1),
  /** Absent on legacy rows written before decisions shared the ledger; read as `learning`. */
  kind: z.enum(['learning', 'decision']).optional(),
  /** The signal body, verbatim. `.refine` (not `.transform`) rejects blank prose without rewriting it. */
  text: z.string().refine((t) => t.trim().length > 0, { message: 'learning text must not be empty' }),
  context: z.string().optional(),
  appliesTo: z.string().optional(),
  /** Absolute repo path; `repoName` is the repo's display name. */
  repo: z.string(),
  repoName: z.string(),
  taskKind: taskKindSchema,
  sprintId: z.string(),
  taskId: z.string(),
  timestamp: z.string(),
  /** Set when distill folds the learning into a context file; `null` while pending. Decisions stay `null`. */
  promotedAt: z.string().nullable(),
  /** Set when the operator declines it at the distill gate; absent on legacy rows (→ not retired). */
  retiredAt: z.string().nullable().optional(),
  /** Ids of near-duplicate rows `compactLedger` merged into this one — additive provenance. */
  supersedes: z.array(z.string()).readonly().optional(),
});

export type LearningRecord = Readonly<z.infer<typeof learningRecordSchema>>;

/**
 * Parse one NDJSON line into a {@link LearningRecord}. Blank lines yield `Result.ok(undefined)`
 * (a trailing newline is normal for an append-only ledger). A malformed line yields a
 * `ParseError` carrying the offending line — the caller decides whether to skip or fail.
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

const sha1Of = (key: string): string => hash('sha1', key).slice(0, 16);

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
 */
export const deriveLearningId = (repo: string, taskKind: TaskKind, text: string): string =>
  sha1Of(`${repo}|${taskKind}|${normalizeForId(text)}`);

/**
 * Derive the stable dedup id for a DECISION. Same scheme as {@link deriveLearningId} but with a
 * `decision` segment folded into the key, so an identical sentence emitted BOTH as a learning and as
 * a decision keeps two distinct ledger rows (the shared file would otherwise collapse them onto one).
 */
export const deriveDecisionId = (repo: string, taskKind: TaskKind, text: string): string =>
  sha1Of(`${repo}|${taskKind}|decision|${normalizeForId(text)}`);

/**
 * The record's {@link MemoryKind}, defaulting a legacy row (no `kind` field) to `learning`. The
 * single place the absent-field default lives, so every consumer agrees on it.
 */
export const recordKind = (record: LearningRecord): MemoryKind => record.kind ?? 'learning';

/** True iff the record is a `learning` (or a legacy row, which defaults to `learning`). */
export const isLearning = (record: LearningRecord): boolean => recordKind(record) === 'learning';

/** True iff the record is a `decision`. */
export const isDecision = (record: LearningRecord): boolean => recordKind(record) === 'decision';

/**
 * True iff the record has been durably RETIRED (the operator declined it at the distill gate). A
 * retired record is excluded from prompt injection and never re-proposed. Tolerates both `null`
 * (explicit "not retired") and absent (legacy row) as live.
 */
export const isRetired = (record: LearningRecord): boolean =>
  record.retiredAt !== undefined && record.retiredAt !== null;
