import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { DraftSprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';

/**
 * Context flowing through the create-sprint chain. Optional fields are populated by upstream
 * leaves: `project` by `loadProjectLeaf`, `sprintName` by the interactive leaf, and
 * `sprint` + `execution` by the create-sprint leaf.
 */
export interface CreateSprintCtx {
  readonly projectId: ProjectId;
  readonly project?: Project;
  readonly sprintName?: string;
  readonly sprint?: DraftSprint;
  readonly execution?: SprintExecution;
}
