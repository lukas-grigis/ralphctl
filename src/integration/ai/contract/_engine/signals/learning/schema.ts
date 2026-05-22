import { z } from 'zod';
import type { LearningSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `learning` AI signal — a cross-task insight pinned under `## Learnings`
 * in `progress.md`.
 */
/** @public */
export const learningSignalSchema = z.object({
  type: z.literal('learning'),
  text: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof learningSignalSchema>, LearningSignal> = true;
void _typeCheck;
