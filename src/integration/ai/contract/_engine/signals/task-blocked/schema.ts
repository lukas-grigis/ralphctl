import { z } from 'zod';
import type { TaskBlockedSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `task-blocked` AI signal — generator-emitted self-block reason. Drives
 * the task transition to `blocked` status; the reason becomes the audit row's body.
 */
/** @public */
export const taskBlockedSignalSchema = z.object({
  type: z.literal('task-blocked'),
  reason: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskBlockedSignalSchema>, TaskBlockedSignal> = true;
void _typeCheck;
