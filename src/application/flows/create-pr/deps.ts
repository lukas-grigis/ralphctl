import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

export interface CreatePrDeps {
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  readonly pullRequestCreator: PullRequestCreator;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}
