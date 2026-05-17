import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Context flowing through the plan chain. Optional fields populate as upstream leaves run.
 *
 * Plan is **always interactive** — `currentUnitRoot`, `currentPromptFile`, and
 * `currentOutputFile` are set by the build-unit + render-prompt-to-file leaves. The
 * `call-planner-interactive` leaf reads the AI's output file, parses tasks, transitions the
 * sprint, and writes them back onto ctx (`sprint` becomes `PlannedSprint`, `tasks` is the
 * new `TodoTask[]`).
 */
export interface PlanCtx {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly sprint?: Sprint;
  readonly project?: Project;
  readonly execution?: SprintExecution;
  /** Existing tasks loaded from the repo (replan support). The interactive leaf overwrites this. */
  readonly tasks?: readonly Task[];
  /** Per-run sandbox under `<sprintDir>/plan/<run-slug>/`. */
  readonly currentUnitRoot?: AbsolutePath;
  readonly currentPromptFile?: AbsolutePath;
  readonly currentOutputFile?: AbsolutePath;
  /** Set by the interactive leaf when the AI returns a valid plan. Used for downstream UI. */
  readonly plannedTasks?: readonly TodoTask[];
}
