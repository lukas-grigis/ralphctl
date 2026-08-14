import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { PlanCheckReport } from '@src/business/sprint/check-plan.ts';

/**
 * Context flowing through the plan chain. Optional fields populate as upstream leaves run.
 *
 * Plan is **always interactive** — `currentUnitRoot`, `currentPromptFile`, and
 * `currentOutputFile` are set by the build-unit + render-prompt-to-file leaves. The
 * `call-planner-interactive` leaf reads the AI's output file and parses it into
 * `proposedTasks`; `check-plan` folds the deterministic critic's findings onto `planCheck`;
 * `apply-plan` runs the HITL gate and the `draft → planned` transition, overwriting `sprint`
 * and `tasks`.
 */
export interface PlanCtx {
  readonly sprintId: SprintId;
  readonly projectId: ProjectId;
  readonly sprint?: Sprint;
  readonly project?: Project;
  readonly execution?: SprintExecution;
  /** Existing tasks loaded from the repo (replan support). `apply-plan` overwrites this on accept and restores it on reject. */
  readonly tasks?: readonly Task[];
  /** Per-run sandbox under `<sprintDir>/plan/<run-slug>/`. */
  readonly currentUnitRoot?: AbsolutePath;
  readonly currentPromptFile?: AbsolutePath;
  readonly currentOutputFile?: AbsolutePath;
  /**
   * The planner's parsed task list, BEFORE the human approval gate. Written by
   * `call-planner-interactive`, read by `check-plan` (critic input) and `apply-plan` (the
   * proposal put to the reviewer). A rejected proposal leaves this set — it records what the
   * AI produced, not what was accepted.
   */
  readonly proposedTasks?: readonly TodoTask[];
  /** Deterministic plan-critic report over {@link proposedTasks}. Advisory — never blocks the chain. */
  readonly planCheck?: PlanCheckReport;
  /**
   * Set by `apply-plan` only when the reviewer ACCEPTED the plan (or no reviewer was wired).
   * Still means "accepted" — downstream UI reads it as the approved task list.
   */
  readonly plannedTasks?: readonly TodoTask[];
}
