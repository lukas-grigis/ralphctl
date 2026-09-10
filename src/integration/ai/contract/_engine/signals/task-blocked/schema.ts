import { z } from 'zod';
import type { TaskBlockedSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `task-blocked` AI signal — generator-emitted self-block reason. Drives
 * the task transition to `blocked` status; the reason becomes the audit row's body.
 *
 * `blockerClass` / `question` / `whatUnblocksMe` are OPTIONAL structured triage fields — a legacy
 * reason-only signal (every signal emitted before this shape existed) still validates unchanged.
 */
export const taskBlockedSignalSchema = z.object({
  type: z.literal('task-blocked'),
  reason: z.string(),
  blockerClass: z
    .union([z.literal('missing-information'), z.literal('ambiguous-request'), z.literal('contradictory-information')])
    .optional(),
  question: z.string().optional(),
  whatUnblocksMe: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskBlockedSignalSchema>, TaskBlockedSignal> = true;
void _typeCheck;
