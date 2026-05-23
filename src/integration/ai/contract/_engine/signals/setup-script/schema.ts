import { z } from 'zod';
import type { SetupScriptSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the legacy `setup-script` AI signal — one shell command for the harness's
 * setup gate. Audit [02] drops this kind from the new contract in favour of the
 * `setup-skill-proposal` sidecar; retained for in-flight readiness sessions on older flows.
 */
/** @public */
export const setupScriptSignalSchema = z.object({
  type: z.literal('setup-script'),
  command: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof setupScriptSignalSchema>, SetupScriptSignal> = true;
void _typeCheck;
