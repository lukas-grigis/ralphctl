import { z } from 'zod';
import type { TaskVerifiedSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `task-verified` AI signal — the generator's claim that the task's
 * verification gate passed inside the model. The harness still runs its own verify gate
 * after the spawn; this signal is advisory.
 */
export const taskVerifiedSignalSchema = z.object({
  type: z.literal('task-verified'),
  output: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskVerifiedSignalSchema>, TaskVerifiedSignal> = true;
void _typeCheck;
