import { z } from 'zod';
import type { CommitMessageSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `commit-message` AI signal — generator-proposed message the
 * `commit-task` leaf threads into `git commit -F`. The harness still owns the actual commit;
 * the signal is advisory. The harness appends a ` (#123, !456)` subject suffix at commit time
 * when the task carries external refs; this suffix is not surfaced back onto the signal.
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
