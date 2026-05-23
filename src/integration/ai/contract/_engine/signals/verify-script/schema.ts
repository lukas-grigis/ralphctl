import { z } from 'zod';
import type { VerifyScriptSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the legacy `verify-script` AI signal — one shell command chain for the
 * post-task verify gate. Audit [02] drops this kind from the new contract in favour of
 * `verify-skill-proposal`; retained for in-flight readiness sessions on older flows.
 */
/** @public */
export const verifyScriptSignalSchema = z.object({
  type: z.literal('verify-script'),
  command: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof verifyScriptSignalSchema>, VerifyScriptSignal> = true;
void _typeCheck;
