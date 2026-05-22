import { z } from 'zod';
import type { ChangeSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `change` AI signal — a generator-emitted granular change record
 * (e.g. "added foo", "renamed bar to baz"). Validates the inbound `signals.json` shape;
 * the per-leaf contract composes this into a discriminated union of accepted kinds.
 */
/** @public */
export const changeSignalSchema = z.object({
  type: z.literal('change'),
  text: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof changeSignalSchema>, ChangeSignal> = true;
void _typeCheck;
