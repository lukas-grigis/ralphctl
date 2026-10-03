/**
 * Snapshot loader — reads the current selection's project + sprint + ticket / task counts and reduces them to {@link
 * TriggerInputs} so the flow registry can decide which menu items are enabled.
 */

import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { isUpstreamBlocked } from '@src/domain/entity/task-lifecycle.ts';
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
  /** Top 5 non-done sprints of the selected project, newest first (UUIDv7 lex DESC). */
  readonly recentSprints: readonly Sprint[];
}

const RECENT_SPRINTS_LIMIT = 5;

/**
 * Blocked-task health derived from a task list — independent of `TriggerInputs.resumableTaskCount`, which counts
 * `todo` + `in_progress` and excludes `blocked` entirely.
 */
export interface TaskHealthCounts {
  /** Every task currently `blocked`, upstream + own combined. */
  readonly blockedTaskCount: number;
  /**
   * Subset of `blockedTaskCount` blocked solely on an unfinished prerequisite ({@link isUpstreamBlocked}) —
   * mechanically clearable once the root task unblocks / completes.
   */
  readonly upstreamBlockedTaskCount: number;
}

export const computeTaskHealthCounts = (tasks: readonly Task[]): TaskHealthCounts => {
  let blockedTaskCount = 0;
  let upstreamBlockedTaskCount = 0;
  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    blockedTaskCount += 1;
    if (isUpstreamBlocked(task)) upstreamBlockedTaskCount += 1;
  }
  return { blockedTaskCount, upstreamBlockedTaskCount };
};

/**
 * Batch-loads {@link computeTaskHealthCounts} for a set of sprints — one `findBySprintId` per sprint, run in parallel
 * via a single `Promise.all`.
 */
export const loadTaskHealthBySprintId = async (
  taskRepo: TaskRepository,
  sprints: readonly Sprint[]
): Promise<ReadonlyMap<SprintId, TaskHealthCounts>> => {
  const bySprintId = new Map<SprintId, TaskHealthCounts>();
  await Promise.all(
    sprints.map(async (sprint) => {
      try {
        const taskR = await taskRepo.findBySprintId(sprint.id);
        bySprintId.set(sprint.id, computeTaskHealthCounts(taskR.ok ? taskR.value : []));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        bySprintId.set(sprint.id, { blockedTaskCount: 0, upstreamBlockedTaskCount: 0 });
      }
    })
  );
  return bySprintId;
};

export interface LoadSnapshotDeps {
  readonly projectRepo: ProjectRepository;
  readonly sprintRepo: SprintRepository;
  readonly taskRepo: TaskRepository;
}

/** Project + sprint + the sprint's tasks resolved from the current selection, if any. */
interface ProjectAndSprint {
  readonly project?: Project;
  readonly sprint?: Sprint;
  readonly tasks: readonly Task[];
}

const loadProjectAndSprint = async (
  deps: LoadSnapshotDeps,
  selection: { readonly projectId?: ProjectId; readonly sprintId?: SprintId }
): Promise<ProjectAndSprint> => {
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

  return {
    ...(project !== undefined ? { project } : {}),
    ...(sprint !== undefined ? { sprint } : {}),
    tasks,
  };
};

/** Storage-wide inventory counts, independent of what (if anything) is currently selected. */
interface InventoryCounts {
  readonly projectCount: number;
  readonly sprintCount: number;
  readonly recentSprints: readonly Sprint[];
}

const loadInventoryCounts = async (deps: LoadSnapshotDeps, project: Project | undefined): Promise<InventoryCounts> => {
  // Inventory: total projects and total sprints scoped to the selected project.
  const allProjects = await deps.projectRepo.list();
  const projectCount = allProjects.ok ? allProjects.value.length : 0;
  let sprintCount = 0;
  let recentSprints: readonly Sprint[] = [];
  if (project !== undefined) {
    const sprints = await deps.sprintRepo.list();
    if (sprints.ok) {
      const projectSprints = sprints.value.filter((s) => s.projectId === project.id);
      sprintCount = projectSprints.length;
      // UUIDv7 ids are time-ordered, so a reverse on the sorted list gives newest-first.
      recentSprints = [...projectSprints]
        .reverse()
        .filter((s) => s.status !== 'done')
        .slice(0, RECENT_SPRINTS_LIMIT);
    }
  }

  return { projectCount, sprintCount, recentSprints };
};

/** Reduce the resolved project/sprint/tasks to the {@link TriggerInputs} the registry consumes. */
const computeTriggerInputs = (
  project: Project | undefined,
  sprint: Sprint | undefined,
  tasks: readonly Task[]
): TriggerInputs => {
  const pendingTicketCount = sprint !== undefined ? sprint.tickets.filter((t) => t.status === 'pending').length : 0;
  const approvedTicketCount = sprint !== undefined ? sprint.tickets.filter((t) => t.status === 'approved').length : 0;
  // Resumable = anything `launchImplement` would pick up.
  const resumableTaskCount = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;

  return {
    hasProject: project !== undefined,
    ...(sprint !== undefined ? { currentSprintStatus: sprint.status } : {}),
    pendingTicketCount,
    approvedTicketCount,
    resumableTaskCount,
    // Not a gate — the ONLY consumer is the `minResumableTasks` failure sentence, which needs to tell "no task list
    // yet, run Plan" apart from "the list exists and every remaining task is blocked".
    blockedTaskCount: computeTaskHealthCounts(tasks).blockedTaskCount,
  };
};

/**
 * Snapshot for a view that already holds a loaded sprint + its tasks (sprint detail) and so has no reason to re-poll
 * the repos.
 */
export const snapshotFromLoadedSprint = (input: {
  readonly project?: Project | undefined;
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}): AppStateSnapshot => ({
  ...(input.project !== undefined ? { project: input.project } : {}),
  sprint: input.sprint,
  tasks: input.tasks,
  triggerInputs: computeTriggerInputs(input.project, input.sprint, input.tasks),
  projectCount: 1,
  sprintCount: 1,
  recentSprints: [],
});

export const loadAppStateSnapshot = async (
  deps: LoadSnapshotDeps,
  selection: { readonly projectId?: ProjectId; readonly sprintId?: SprintId }
): Promise<AppStateSnapshot> => {
  const { project, sprint, tasks } = await loadProjectAndSprint(deps, selection);
  const { projectCount, sprintCount, recentSprints } = await loadInventoryCounts(deps, project);
  const triggerInputs = computeTriggerInputs(project, sprint, tasks);

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
