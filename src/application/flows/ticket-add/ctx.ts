import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';

export interface TicketAddInput {
  readonly sprintId: SprintId;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
}

export interface TicketAddCtx {
  readonly input: TicketAddInput;
  readonly output?: Ticket;
}
