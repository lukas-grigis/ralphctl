import { z } from 'zod';
import type { Result } from '@src/domain/result.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { ParseError } from '@src/domain/value/error/parse-error.ts';
import { HttpUrlSchema, TicketIdSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import { type Compatible, safeParseToResult } from '@src/integration/persistence/shared/codec-internal.ts';

const TicketBaseShape = {
  id: TicketIdSchema,
  title: z.string(),
  description: z.string().optional(),
  link: HttpUrlSchema.optional(),
};

const PendingTicketSchema = z.object({
  ...TicketBaseShape,
  status: z.literal('pending'),
  requirements: z.undefined().optional(),
});

const ApprovedTicketSchema = z.object({
  ...TicketBaseShape,
  status: z.literal('approved'),
  requirements: z.string(),
});

export const TicketSchema = z.discriminatedUnion('status', [PendingTicketSchema, ApprovedTicketSchema]);

export const fromJsonTicket = (input: unknown): Result<Ticket, ParseError> => safeParseToResult(TicketSchema, input);

type _checkTicket = Compatible<Ticket, z.infer<typeof TicketSchema>>;
const _typeChecks: [_checkTicket] = [true];
void _typeChecks;
