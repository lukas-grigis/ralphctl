import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

export interface TicketAddInput {
  readonly sprintId: SprintId;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly createTrackerIssue?: boolean;
}

export interface TicketAddCtx {
  readonly input: TicketAddInput;
  readonly output?: Ticket;
  readonly trackerError?: DomainError;
}
