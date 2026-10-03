import { uuidv7Id } from '@src/domain/value/uuid7.ts';

declare const __ticketId: unique symbol;
export type TicketId = string & { readonly [__ticketId]: 'TicketId' };

export const TicketId = uuidv7Id<TicketId>('ticket');
