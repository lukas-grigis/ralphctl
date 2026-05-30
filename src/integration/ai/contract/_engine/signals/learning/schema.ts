import { z } from 'zod';
import type { LearningSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `learning` AI signal — a structured insight pinned under `## Learnings`
 * in `progress.md`. `text` is the required Insight; `context` (when / why it arose) and
 * `appliesTo` (where it applies) are optional. Old rows omitting them still parse.
 */
export const learningSignalSchema = z.object({
  type: z.literal('learning'),
  text: z.string(),
  context: z.string().optional(),
  appliesTo: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof learningSignalSchema>, LearningSignal> = true;
void _typeCheck;
