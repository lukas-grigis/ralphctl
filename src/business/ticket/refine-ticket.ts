import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type DraftSprint, replaceTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import {
  approveTicketRequirements,
  type ApprovedTicket,
  type PendingTicket,
  type Ticket,
} from '@src/domain/entity/ticket.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Approve a pending ticket's refined requirements and swap the updated ticket into its draft
 * sprint — gated by an optional `reviewBeforeApprove` hook so a human can veto the AI's
 * proposal before it lands on the entity.
 *
 * Decisions owned by this use case:
 *  - Empty / whitespace-only body → `InvalidStateError`. The AI exited but produced nothing
 *    useful; surfacing this as a domain error halts the per-ticket sub-chain so the next ticket
 *    still gets a chance to run.
 *  - `reviewBeforeApprove` returned `accept: false` → ticket stays `pending`, sprint stays
 *    unchanged, output's `accepted` flag is `false`. The chain leaf reads this flag and
 *    skips persistence side-effects (no append to `refinedTickets`).
 *  - `approveTicketRequirements` validation failure → forwarded (ticket-shape rules).
 *  - `replaceTicket` failure → forwarded (sprint must be draft, ticket must exist on it).
 *
 * The hook is plumbed in from the chain layer — production wires it to a queued TUI review
 * prompt; tests and headless callers can omit it for "auto-accept" semantics.
 */
export interface RefineTicketProps {
  readonly sprint: Sprint;
  readonly ticket: PendingTicket;
  readonly requirementsBody: string;
  readonly logger: Logger;
  /**
   * Human-in-the-loop approval callback. Called AFTER the requirements body is parsed and
   * BEFORE the entity transitions. Resolve with:
   *   - `{accept: false}` → reject; ticket stays pending.
   *   - `{accept: true, body?: string}`  → approve locally only. When `body` is supplied the
   *     reviewer edited the AI's proposal and the use case persists the edit instead of the
   *     original `requirementsBody`.
   *   - `{accept: true, alsoUpdateOrigin: true, body?: string}` → approve AND request the chain
   *     leaf to push back to the issue tracker. The use case only forwards the flag — actual
   *     push is the leaf's job. `body` overrides as above.
   * When omitted the AI's body is auto-accepted — appropriate for CI / headless runs.
   */
  readonly reviewBeforeApprove?: (
    proposed: string,
    ticket: PendingTicket
  ) => Promise<{ readonly accept: boolean; readonly alsoUpdateOrigin?: boolean; readonly body?: string }>;
}

export interface RefineTicketOutput {
  /** Updated sprint on accept, unchanged input sprint on reject. */
  readonly sprint: Sprint;
  /** `ApprovedTicket` on accept, the input `PendingTicket` on reject. */
  readonly ticket: Ticket;
  /** `true` when the requirements were approved; `false` when the reviewer rejected. */
  readonly accepted: boolean;
  /** Forwarded reviewer intent. The chain leaf consumes this to decide whether to push. */
  readonly alsoUpdateOrigin: boolean;
}

export const refineTicketUseCase = async (
  props: RefineTicketProps
): Promise<Result<RefineTicketOutput, ConflictError | InvalidStateError | NotFoundError | ValidationError>> => {
  const log = props.logger.named('ticket.refine');
  log.debug('approving refined ticket', { ticketId: props.ticket.id, bodyLength: props.requirementsBody.length });

  if (props.requirementsBody.trim().length === 0) {
    log.warn('AI produced no requirements body', { ticketId: props.ticket.id });
    return Result.error(
      new InvalidStateError({
        entity: 'ticket',
        currentState: 'pending',
        attemptedAction: 'refine-ticket',
        message: `refine-ticket: empty requirements body for ticket '${String(props.ticket.id)}'`,
      })
    );
  }

  let alsoUpdateOrigin = false;
  let finalBody = props.requirementsBody;
  if (props.reviewBeforeApprove !== undefined) {
    const decision = await props.reviewBeforeApprove(props.requirementsBody, props.ticket);
    if (!decision.accept) {
      log.info('reviewer rejected refined requirements — leaving ticket pending', {
        ticketId: props.ticket.id,
      });
      return Result.ok({ sprint: props.sprint, ticket: props.ticket, accepted: false, alsoUpdateOrigin: false });
    }
    alsoUpdateOrigin = decision.alsoUpdateOrigin === true;
    if (decision.body !== undefined && decision.body.trim().length > 0) finalBody = decision.body;
  }

  const approved = approveTicketRequirements(props.ticket, finalBody);
  if (!approved.ok) {
    log.warn('approveTicketRequirements failed', { ticketId: props.ticket.id, error: approved.error.message });
    return Result.error(approved.error);
  }

  const replaced = replaceTicket(props.sprint, approved.value.id, approved.value);
  if (!replaced.ok) {
    log.warn('replaceTicket failed', { ticketId: props.ticket.id, error: replaced.error.message });
    return Result.error(replaced.error);
  }

  log.info(`refined ticket '${approved.value.title}'`, {
    ticketId: approved.value.id,
    title: approved.value.title,
    bodyLength: props.requirementsBody.length,
  });
  return Result.ok({
    sprint: replaced.value as DraftSprint,
    ticket: approved.value as ApprovedTicket,
    accepted: true,
    alsoUpdateOrigin,
  });
};
