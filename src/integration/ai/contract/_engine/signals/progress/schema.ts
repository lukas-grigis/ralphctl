import { z } from 'zod';
import type { ProgressSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the legacy short-form `progress` AI signal — a one-line summary with an
 * optional file list. Retained for in-flight compatibility; new flows produce the richer
 * `progress-entry` shape instead.
 */
export const progressSignalSchema = z.object({
  type: z.literal('progress'),
  summary: z.string(),
  files: z.array(z.string()).readonly().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof progressSignalSchema>, ProgressSignal> = true;
void _typeCheck;
