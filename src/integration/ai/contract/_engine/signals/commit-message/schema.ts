import { z } from 'zod';
import type { CommitMessageSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `commit-message` AI signal — generator-proposed message the
 * `commit-task` leaf threads into `git commit -F`. The harness still owns the actual commit;
 * the signal is advisory. Deterministic trailers (`Closes #…`) are appended by the harness at
 * commit time and not surfaced back onto the signal.
 */
/** @public */
export const commitMessageSignalSchema = z.object({
  type: z.literal('commit-message'),
  subject: z.string(),
  body: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof commitMessageSignalSchema>, CommitMessageSignal> = true;
void _typeCheck;
