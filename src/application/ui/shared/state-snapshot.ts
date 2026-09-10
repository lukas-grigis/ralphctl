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

/**
 * Blocked-task health derived from a task list — independent of `TriggerInputs.resumableTaskCount`,
 * which counts `todo` + `in_progress` and excludes `blocked` entirely. A sprint whose entire
 * remainder is blocked has `resumableTaskCount === 0`, which used to read as "nothing pending"
 * everywhere this shows up; these two numbers are how every orientation surface (Home, the
 * settled ResultCard, the Sprints list, the sprint picker) counts the stuck work instead of
 * silently dropping it.
 *
 * NOT folded into {@link TriggerInputs} — that type is owned by the flow-gating registry
 * (`registry-triggers.ts`) and no flow trigger gates on it today. Kept as a standalone helper so
 * every consumer (this module, `next-steps.ts`, the Execute view's settled-run projection) derives
 * it the same way from whatever task list it already has, rather than each re-deriving its own
 * `todo`/`in_progress`-shaped filter.
 */
export interface TaskHealthCounts {
  /** Every task currently `blocked`, upstream + own combined. */
  readonly blockedTaskCount: number;
  /**
   * Subset of `blockedTaskCount` blocked solely on an unfinished prerequisite
   * ({@link isUpstreamBlocked}) — mechanically clearable once the root task unblocks / completes.
   * `blockedTaskCount - upstreamBlockedTaskCount` is blocked on its OWN merits (eval / verify /
   * budget / operator cancel) and needs a real fix, never an automatic cascade.
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
 * Batch-loads {@link computeTaskHealthCounts} for a set of sprints — one `findBySprintId` per
 * sprint, run in parallel via a single `Promise.all`, never a fetch per rendered row (which would
 * re-run on every scroll / re-render and could stall a list with many sprints). One sprint's
 * fetch throwing degrades ONLY that sprint to zero counts rather than failing the whole batch;
 * `AbortError` is the one exception — it propagates so a cancelled load surfaces as a cancel, not
 * a silently-degraded result.
 *
 * The Sprints list and the cross-project sprint picker both need this — extracted here (instead
 * of each view re-deriving its own fetch-and-guard loop) so a future change to the fetch (e.g.
 * batching by project) has exactly one call site to edit.
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
  // Resumable = anything `launchImplement` would pick up. `todo` is the obvious case;
  // `in_progress` is the resume case (a leftover running attempt from a crashed prior run
  // settles as `aborted` and the task gets a fresh attempt). Counting only `todo` would gray
  // out Implement after a crash, defeating resume.
  const resumableTaskCount = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;

  return {
    hasProject: project !== undefined,
    ...(sprint !== undefined ? { currentSprintStatus: sprint.status } : {}),
    pendingTicketCount,
    approvedTicketCount,
    resumableTaskCount,
  };
};

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
