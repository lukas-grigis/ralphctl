import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';

export interface TicketRemoveInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
}

export interface TicketRemoveOutput {
  readonly removed: boolean;
  readonly remainingTickets: number;
}

export interface TicketRemoveCtx {
  readonly input: TicketRemoveInput;
  readonly output?: TicketRemoveOutput;
}
