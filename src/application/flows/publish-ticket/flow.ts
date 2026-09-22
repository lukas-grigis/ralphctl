import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  publishSaveFailedError,
  publishTicketToTracker,
  type PublishTicketToTrackerOutput,
} from '@src/business/ticket/publish-to-tracker.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { TicketPublishCtx, TicketPublishInput } from '@src/application/flows/publish-ticket/ctx.ts';
import type { TicketPublishDeps } from '@src/application/flows/publish-ticket/deps.ts';

/**
 * Create a tracker issue for a ticket, or post an idempotent refinement comment on an
 * existing link. Linear: load sprint → load its project → publish against the first
 * repository path → save the returned sprint. Origin is always that first repo; the
 * project's `defaultIssueOrigin` is not consulted.
 */
export const createTicketPublishFlow = (deps: TicketPublishDeps): Element<TicketPublishCtx> =>
  leaf<TicketPublishCtx, TicketPublishInput, PublishTicketToTrackerOutput>('publish-ticket', {
    useCase: {
      async execute(input) {
        const sprint = await deps.sprintRepo.findById(input.sprintId);
        if (!sprint.ok) return Result.error(sprint.error);

        const project = await deps.projectRepo.findById(sprint.value.projectId);
        if (!project.ok) return Result.error(project.error);

        const originCwd = project.value.repositories[0]?.path;
        if (originCwd === undefined) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: 'Project has no repositories — add one first.',
            })
          );
        }

        const published = await publishTicketToTracker({
          sprint: sprint.value,
          ticketId: input.ticketId,
          cwd: originCwd,
          issuePusher: deps.issuePusher,
        });
        if (!published.ok) return Result.error(published.error);

        const saved = await deps.sprintRepo.save(published.value.sprint);
        if (!saved.ok) return Result.error(publishSaveFailedError(published.value, input.ticketId, saved.error));

        return Result.ok(published.value);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
