/**
 * Snapshot loader — reads the current selection's project + sprint + ticket / task counts and
 * reduces them to {@link TriggerInputs} so the flow registry can decide which menu items are
 * enabled.
 *
 * Used by:
 *  - The flows view (renders enabled / disabled state with reasons).
 *  - The home view (summary card).
 *  - The flow launcher (sanity check before instantiating a runner).
 */

import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { TriggerInputs } from '@src/application/registry-triggers.ts';

export interface AppStateSnapshot {
  readonly project?: Project;
  readonly sprint?: Sprint;
  readonly tasks: readonly Task[];
  readonly triggerInputs: TriggerInputs;
  /** Total projects in storage. Lets the home view tell apart "no projects yet" vs "many, none picked". */
  readonly projectCount: number;
  /** Total sprints in storage scoped to the selected project (or 0 when none). */
  readonly sprintCount: number;
  /**
   * Top 5 non-done sprints of the selected project, newest first (UUIDv7 lex DESC). Powers
   * the Home view's inline sprint picker — pick one to switch the current selection without
   * leaving Home. `done` sprints are intentionally excluded so the shortcut surfaces only work
   * the user can still act on; closed sprints stay reachable via the full `S` picker. Empty
   * when no project is selected. When there are > 5 candidates the full list is still
   * reachable via the picker; this slice is the at-a-glance affordance.
   */
  readonly recentSprints: readonly Sprint[];
}

const RECENT_SPRINTS_LIMIT = 5;

export interface LoadSnapshotDeps {
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly taskRepo: TaskRepository;
}

export const loadAppStateSnapshot = async (
  deps: LoadSnapshotDeps,
  selection: { readonly projectId?: ProjectId; readonly sprintId?: SprintId }
): Promise<AppStateSnapshot> => {
  let project: Project | undefined;
  if (selection.projectId !== undefined) {
    const r = await deps.projectRepo.findById(selection.projectId);
    if (r.ok) project = r.value;
  }

  let sprint: Sprint | undefined;
  if (selection.sprintId !== undefined) {
    const r = await deps.sprintRepo.findById(selection.sprintId);
    if (r.ok) sprint = r.value;
  }

  let tasks: readonly Task[] = [];
  if (sprint !== undefined) {
    const r = await deps.taskRepo.findBySprintId(sprint.id);
    if (r.ok) tasks = r.value;
  }

  // Inventory: total projects and total sprints scoped to the selected project. Used by the
  // home view to differentiate "no projects yet" from "many projects, none picked" — the
  // CTAs differ ("create a project" vs "pick a project").
  const allProjects = await deps.projectRepo.list();
  const projectCount = allProjects.ok ? allProjects.value.length : 0;
  let sprintCount = 0;
  let recentSprints: readonly Sprint[] = [];
  if (project !== undefined) {
    const sprints = await deps.sprintRepo.list();
    if (sprints.ok) {
      const projectSprints = sprints.value.filter((s) => s.projectId === project.id);
      sprintCount = projectSprints.length;
      // UUIDv7 ids are time-ordered, so a reverse on the sorted list gives newest-first. Done
      // sprints are dropped from the shortcut window so Home only surfaces work the user can
      // still act on; the full picker (`S`) still lists them.
      recentSprints = [...projectSprints]
        .reverse()
        .filter((s) => s.status !== 'done')
        .slice(0, RECENT_SPRINTS_LIMIT);
    }
  }

  const pendingTicketCount = sprint !== undefined ? sprint.tickets.filter((t) => t.status === 'pending').length : 0;
  const approvedTicketCount = sprint !== undefined ? sprint.tickets.filter((t) => t.status === 'approved').length : 0;
  // Resumable = anything `launchImplement` would pick up. `todo` is the obvious case;
  // `in_progress` is the resume case (a leftover running attempt from a crashed prior run
  // settles as `aborted` and the task gets a fresh attempt). Counting only `todo` would gray
  // out Implement after a crash, defeating resume.
  const resumableTaskCount = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;

  const triggerInputs: TriggerInputs = {
    hasProject: project !== undefined,
    ...(sprint !== undefined ? { currentSprintStatus: sprint.status } : {}),
    pendingTicketCount,
    approvedTicketCount,
    resumableTaskCount,
  };

  return {
    ...(project !== undefined ? { project } : {}),
    ...(sprint !== undefined ? { sprint } : {}),
    tasks,
    triggerInputs,
    projectCount,
    sprintCount,
    recentSprints,
  };
};
