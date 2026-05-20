import type { PullRequestCreator } from '@src/business/scm/pull-request-creator.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

export interface CreatePrDeps {
  readonly sprintRepo: SprintRepository;
  readonly sprintExecutionRepo: SprintExecutionRepository;
  /**
   * Slim repo port used to enrich the derived PR body with the sprint's completed tasks.
   * Loaded inside the flow so the CLI / TUI callers don't have to pre-load — the chain's
   * single I/O step keeps the call-sites symmetric across surfaces.
   */
  readonly taskRepo: FindTasksBySprintId;
  readonly pullRequestCreator: PullRequestCreator;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}
