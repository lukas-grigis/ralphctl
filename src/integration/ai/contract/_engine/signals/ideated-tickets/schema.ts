import { z } from 'zod';
import type { IdeatedTicketsSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `ideated-tickets` AI signal — produced by the ideate flow's AI session.
 * Carries the raw output JSON envelope (`{ requirements, tasks }`); `parseIdeateOutput` /
 * `parseTaskList` resolves cross-references downstream. No sidecar — the harness projects the
 * approved ticket + tasks onto the sprint via `addApprovedTicketUseCase`.
 *
 * Wave 6 will replace `outputJson` with structured fields once the prompt asks the AI to
 * write the wrapper directly.
 */
export const ideatedTicketsSignalSchema = z.object({
  type: z.literal('ideated-tickets'),
  outputJson: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof ideatedTicketsSignalSchema>, IdeatedTicketsSignal> = true;
void _typeCheck;
