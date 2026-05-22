import { z } from 'zod';
import type { CommitMessageSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `commit-message` AI signal — generator-proposed message the
 * `commit-task` leaf threads into `git commit -F`. The harness still owns the actual commit;
 * the signal is advisory.
 *
 * `body` and `fullMessage` are both optional — `fullMessage` is harness-populated post-
 * finalisation and never present at AI write time. The schema accepts both for round-trip.
 */
/** @public */
export const commitMessageSignalSchema = z.object({
  type: z.literal('commit-message'),
  subject: z.string(),
  body: z.string().optional(),
  fullMessage: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof commitMessageSignalSchema>, CommitMessageSignal> = true;
void _typeCheck;
