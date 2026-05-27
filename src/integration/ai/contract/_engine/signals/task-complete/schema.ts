import { z } from 'zod';
import type { TaskCompleteSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `task-complete` AI signal — emitted by the generator only after a
 * preceding `task-verified` signal. Ordering is enforced by the consuming leaf (or schema-
 * level refinement), not the type.
 */
export const taskCompleteSignalSchema = z.object({
  type: z.literal('task-complete'),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskCompleteSignalSchema>, TaskCompleteSignal> = true;
void _typeCheck;
