import { z } from 'zod';
import type { NoteSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `note` AI signal — a low-stakes narrative pin under `## Notes`
 * in `progress.md`.
 */
/** @public */
export const noteSignalSchema = z.object({
  type: z.literal('note'),
  text: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof noteSignalSchema>, NoteSignal> = true;
void _typeCheck;
