import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { PublishTracker } from '@src/business/ticket/publish-to-tracker.ts';

export interface TicketPublishDeps {
  readonly sprintRepo: SprintRepository;
  readonly projectRepo: ProjectRepository;
  readonly issuePusher: PublishTracker;
}
