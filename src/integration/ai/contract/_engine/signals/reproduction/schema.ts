import { z } from 'zod';
import type { ReproductionSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `reproduction` AI signal — the failing test + run command a `reproduce`
 * session wrote to demonstrate a reported defect, plus the existing tests it judged relevant.
 * `relevantTests` is required but may be an empty array — the session searched and found
 * nothing relevant, which is a meaningful answer distinct from an omitted field.
 */
export const reproductionSignalSchema = z.object({
  type: z.literal('reproduction'),
  testPath: z.string(),
  runCommand: z.string(),
  observedFailure: z.string(),
  relevantTests: z.array(z.string()).readonly(),
  notes: z.string().optional(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof reproductionSignalSchema>, ReproductionSignal> = true;
void _typeCheck;
