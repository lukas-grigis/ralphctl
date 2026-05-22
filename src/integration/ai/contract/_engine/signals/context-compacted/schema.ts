import { z } from 'zod';
import type { ContextCompactedSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `context-compacted` AI signal — provider-emitted lifecycle marker for
 * context-window auto-compaction. Both token counts and the preserved-topics list are
 * optional; providers vary on what they expose.
 */
/** @public */
export const contextCompactedSignalSchema = z.object({
  type: z.literal('context-compacted'),
  beforeTokens: z.number().optional(),
  afterTokens: z.number().optional(),
  preservedTopics: z.array(z.string()).readonly().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof contextCompactedSignalSchema>, ContextCompactedSignal> = true;
void _typeCheck;
