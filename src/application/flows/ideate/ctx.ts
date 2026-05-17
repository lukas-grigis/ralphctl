import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ApprovedTicket } from '@src/domain/entity/ticket.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Context flowing through the ideate chain. Required initial inputs (set by the launcher / CLI
 * caller) — `sprintId`, `projectId`, `ideaTitle`, `ideaText`, `cwd`. Everything else is set by
 * upstream leaves.
 */
export interface IdeateCtx {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly ideaTitle: string;
  readonly ideaText: string;
  readonly cwd: AbsolutePath;

  readonly sprint?: Sprint;
  readonly project?: Project;
  /** Existing tasks loaded from the repo; ideate-and-plan appends new ones. */
  readonly tasks?: readonly Task[];

  /** Per-run sandbox under `<sprintDir>/ideate/`. */
  readonly currentUnitRoot?: AbsolutePath;
  readonly currentPromptFile?: AbsolutePath;
  readonly currentOutputFile?: AbsolutePath;

  /** Set by `ideate-and-plan`; useful for the post-flow UI to show what was created. */
  readonly addedTicket?: ApprovedTicket;
}
