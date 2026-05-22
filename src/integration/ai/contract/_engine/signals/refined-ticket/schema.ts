import { z } from 'zod';
import type { RefinedTicketSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `refined-ticket` AI signal — produced by the refine flow's AI session.
 * Body is markdown prose; uncapped on persistence per audit [03]. The harness projects the
 * body onto the `PendingTicket` entity via `refineTicketUseCase`; no sidecar is written.
 */
/** @public */
export const refinedTicketSignalSchema = z.object({
  type: z.literal('refined-ticket'),
  body: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof refinedTicketSignalSchema>, RefinedTicketSignal> = true;
void _typeCheck;
