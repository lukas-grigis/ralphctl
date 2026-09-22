import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { PublishTracker } from '@src/business/ticket/publish-to-tracker.ts';
import { createTicketAddFlow } from '@src/application/flows/add-ticket/flow.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';

const ISSUE_URL = 'https://github.com/x/y/issues/42';

describe('createTicketAddFlow — tracker issue', () => {
  it('reports the created URL when saving the link fails after a successful create', async () => {
    let current: Sprint = makeDraftSprint({ tickets: [] });
    let saves = 0;
    const sprintRepo = {
      findById: async () => Result.ok(current),
      save: async (sprint: Sprint) => {
        saves += 1;
        // First save persists the new ticket; the second (link write-back) fails.
        if (saves > 1) return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
        current = sprint;
        return Result.ok(undefined);
      },
    } as unknown as SprintRepository;
    const projectRepo = { findById: async () => Result.ok(makeProject()) } as unknown as ProjectRepository;
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

    const flow = createTicketAddFlow({ sprintRepo, projectRepo, issuePusher: tracker });
    const r = await flow.execute({ input: { sprintId: current.id, title: 'New thing', createTrackerIssue: true } });

    expect(creates).toBe(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ctx.output?.title).toBe('New thing');
    expect(r.value.ctx.trackerError?.message).toContain(`Issue created at ${ISSUE_URL}`);
    expect(r.value.ctx.trackerError?.message).toContain('re-publishing would open a duplicate');
    expect(r.value.ctx.trackerIssueOrphaned).toBe(true);
  });
});
