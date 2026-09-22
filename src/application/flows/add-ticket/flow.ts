import { Result } from '@src/domain/result.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { createTicket } from '@src/domain/entity/ticket.ts';
import { addTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { publishSaveFailedError, publishTicketToTracker } from '@src/business/ticket/publish-to-tracker.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { TicketAddCtx, TicketAddInput } from '@src/application/flows/add-ticket/ctx.ts';
import type { TicketAddDeps } from '@src/application/flows/add-ticket/deps.ts';

interface TicketAddLeafOutput {
  readonly ticket: Ticket;
  readonly trackerError?: DomainError;
  readonly trackerIssueOrphaned?: boolean;
}

/**
 * Append a pending ticket to a sprint. Linear: load sprint → mint ticket → addTicket guard
 * (refuses non-draft sprints, rejects duplicate ids) → save the updated sprint. When
 * `createTrackerIssue` is set, publish against the first repository path after that save;
 * a tracker failure lands on `ctx.trackerError` and does not fail the leaf. When the issue
 * was created but the link save failed, `ctx.trackerIssueOrphaned` is set and the error
 * carries the created URL.
 */
export const createTicketAddFlow = (deps: TicketAddDeps): Element<TicketAddCtx> =>
  leaf<TicketAddCtx, TicketAddInput, TicketAddLeafOutput>('add-ticket', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        const ticketInput: Parameters<typeof createTicket>[0] = {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.link !== undefined ? { link: input.link } : {}),
        };
        const ticket = createTicket(ticketInput);
        if (!ticket.ok) return Result.error(ticket.error);

        const updated = addTicket(sprint.value, ticket.value);
        if (!updated.ok) return Result.error(updated.error);

        const saved = await deps.sprintRepo.save(updated.value);
        if (!saved.ok) return Result.error(saved.error);

        if (input.createTrackerIssue !== true) {
          return Result.ok({ ticket: ticket.value });
        }

        const published = await publishAfterSave(deps, updated.value, ticket.value);
        return Result.ok(published);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({
      ...c,
      output: o.ticket,
      ...(o.trackerError !== undefined ? { trackerError: o.trackerError } : {}),
      ...(o.trackerIssueOrphaned === true ? { trackerIssueOrphaned: true } : {}),
    }),
  });

const publishAfterSave = async (deps: TicketAddDeps, sprint: Sprint, ticket: Ticket): Promise<TicketAddLeafOutput> => {
  const tracker = deps.issuePusher;
  const projectRepo = deps.projectRepo;
  if (tracker === undefined || projectRepo === undefined) {
    return {
      ticket,
      trackerError: new StorageError({
        subCode: 'io',
        message: 'issue tracker is unavailable',
      }),
    };
  }

  const project = await projectRepo.findById(sprint.projectId);
  if (!project.ok) {
    return { ticket, trackerError: project.error };
  }
  const cwd = project.value.repositories[0]?.path;
  if (cwd === undefined) {
    return {
      ticket,
      trackerError: new StorageError({
        subCode: 'io',
        message: 'Project has no repositories — add one first.',
      }),
    };
  }

  const published = await publishTicketToTracker({
    sprint,
    ticketId: ticket.id,
    cwd,
    issuePusher: tracker,
  });
  if (!published.ok) {
    return { ticket, trackerError: published.error };
  }

  const relinked = await deps.sprintRepo.save(published.value.sprint);
  if (!relinked.ok) {
    return {
      ticket,
      trackerError: publishSaveFailedError(published.value, ticket.id, relinked.error),
      ...(published.value.outcome === 'created' ? { trackerIssueOrphaned: true } : {}),
    };
  }

  const withLink = published.value.sprint.tickets.find((t) => t.id === ticket.id) ?? ticket;
  return { ticket: withLink };
};
