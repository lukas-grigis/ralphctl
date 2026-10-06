import { z } from 'zod';
import type { PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import type { QuarantinedDiff } from '@src/domain/entity/task.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

// Every member reads tolerantly: a value this version can't interpret reads as absent instead of
// failing the whole tasks.json — the fields are additive, so there is no migration to lean on.

const count = z.number().int().nonnegative();

const DiffStatSchema = z.object({
  files: count,
  insertions: count,
  deletions: count,
  partial: z.literal(true).optional().catch(undefined),
});

/** Mirrors {@link QuarantinedDiff}; only a missing or empty `stashMessage` drops the whole fact. */
export const QuarantinedDiffSchema = z
  .object({
    stashMessage: z.string().min(1),
    stat: DiffStatSchema.optional().catch(undefined),
    entries: z.number().int().positive().optional().catch(undefined),
    nextAttempt: z.enum(['continue', 'fresh']).optional().catch(undefined),
    decidedAt: IsoTimestampSchema.optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

const PriorWorkNotRestoredReasonSchema = z.enum([
  'dirty-tree',
  'tree-probe-failed',
  'pop-failed',
  'pop-failed-tree-unverified',
  'stash-list-failed',
]);

/** Mirrors {@link PriorWorkOutcome}; an unknown `kind` or `reason` reads as no outcome. */
export const PriorWorkOutcomeSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('restored'),
      stashMessage: z.string(),
      stat: DiffStatSchema.optional().catch(undefined),
    }),
    z.object({ kind: z.literal('kept-by-choice'), stashMessage: z.string() }),
    z.object({
      kind: z.literal('not-restored'),
      stashMessage: z.string(),
      reason: PriorWorkNotRestoredReasonSchema,
      uncommittedPaths: count.optional().catch(undefined),
    }),
  ])
  .optional()
  .catch(undefined);

const _diffStatCheck: Compatible<z.infer<typeof DiffStatSchema>, DiffStat> = true;
void _diffStatCheck;
const _quarantinedDiffCheck: Compatible<NonNullable<z.infer<typeof QuarantinedDiffSchema>>, QuarantinedDiff> = true;
void _quarantinedDiffCheck;
const _priorWorkCheck: Compatible<NonNullable<z.infer<typeof PriorWorkOutcomeSchema>>, PriorWorkOutcome> = true;
void _priorWorkCheck;
