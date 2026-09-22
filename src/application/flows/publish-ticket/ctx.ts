import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TicketId } from '@src/domain/value/id/ticket-id.ts';
import type { PublishTicketToTrackerOutput } from '@src/business/ticket/publish-to-tracker.ts';

export interface TicketPublishInput {
  readonly sprintId: SprintId;
  readonly ticketId: TicketId;
}

export interface TicketPublishCtx {
  readonly input: TicketPublishInput;
  readonly output?: PublishTicketToTrackerOutput;
}
