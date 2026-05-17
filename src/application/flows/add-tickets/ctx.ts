import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { PendingTicket } from '@src/domain/entity/ticket.ts';

/**
 * Context flowing through the add-tickets chain. Optional fields are populated by upstream
 * leaves: `sprint` by `loadSprintLeaf`, `addedTickets` accumulates as the interactive add-loop
 * adds each ticket. The final saved sprint is whichever value of `sprint` survives the loop —
 * see {@link createAddTicketsFlow} for the cancel-mid-loop semantics.
 */
export interface AddTicketsCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  /** Tickets added during this run, in the order they were entered. Used by the TUI for progress. */
  readonly addedTickets?: readonly PendingTicket[];
}
