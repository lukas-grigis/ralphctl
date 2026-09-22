import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { PublishTracker } from '@src/business/ticket/publish-to-tracker.ts';
import { createTicketPublishFlow } from '@src/application/flows/publish-ticket/flow.ts';
import { makeApprovedTicket, makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';

const ISSUE_URL = 'https://github.com/x/y/issues/42';

const creatingTracker = (): { tracker: PublishTracker; creates: () => number } => {
  let creates = 0;
  const tracker: PublishTracker = {
    resolveOrigin: async () => Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' }),
    create: async () => {
      creates += 1;
      return Result.ok({ url: ISSUE_URL });
    },
    listComments: async () => Result.ok([]),
    comment: async () => Result.ok(undefined),
  };
  return { tracker, creates: () => creates };
};

describe('createTicketPublishFlow', () => {
  it('reports the created URL when saving the link fails after a successful create', async () => {
    const ticket = makeApprovedTicket();
    const sprint: Sprint = makeDraftSprint({ tickets: [ticket] });
    const sprintRepo = {
      findById: async () => Result.ok(sprint),
      save: async () => Result.error(new StorageError({ subCode: 'io', message: 'disk full' })),
    } as unknown as SprintRepository;
    const projectRepo = { findById: async () => Result.ok(makeProject()) } as unknown as ProjectRepository;
    const { tracker, creates } = creatingTracker();

    const flow = createTicketPublishFlow({ sprintRepo, projectRepo, issuePusher: tracker });
    const r = await flow.execute({ input: { sprintId: sprint.id, ticketId: ticket.id } });

    expect(creates()).toBe(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error.message).toContain(`Issue created at ${ISSUE_URL}`);
    expect(r.error.error.message).toContain('re-publishing would open a duplicate');
  });
});
