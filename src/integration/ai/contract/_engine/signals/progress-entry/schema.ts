import { z } from 'zod';
import type { ProgressEntrySignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the v1 4-section `progress-entry` AI signal — task / filesChanged /
 * learnings / notesForNext. Empty `learnings` / `notesForNext` strings are valid; the
 * harness renders them as `_None._` on disk.
 */
export const progressEntrySignalSchema = z.object({
  type: z.literal('progress-entry'),
  task: z.string(),
  filesChanged: z.array(z.string()).readonly(),
  learnings: z.string(),
  notesForNext: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof progressEntrySignalSchema>, ProgressEntrySignal> = true;
void _typeCheck;
