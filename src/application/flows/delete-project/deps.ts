import type { Logger } from '@src/business/observability/logger.ts';
import type { HousekeepingDisk } from '@src/business/housekeeping/housekeeping-disk.ts';
import type { RunActivityProbe } from '@src/business/housekeeping/run-activity-probe.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';

export interface DeleteProjectDeps {
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly housekeepingDisk: HousekeepingDisk;
  readonly runActivity: RunActivityProbe;
  readonly logger: Logger;
}
