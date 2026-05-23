import { z } from 'zod';
import type { DecisionSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `decision` AI signal — an architectural / design choice pinned under
 * `## Decisions` in `progress.md`. Body is uncapped on persistence per audit [03].
 */
/** @public */
export const decisionSignalSchema = z.object({
  type: z.literal('decision'),
  text: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof decisionSignalSchema>, DecisionSignal> = true;
void _typeCheck;
