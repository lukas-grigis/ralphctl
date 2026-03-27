import { getTasksFilePath } from '@src/utils/paths.ts';
import { readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { type Task, type Tasks, TasksSchema, type TaskStatus } from '@src/schemas/index.ts';
import { assertSprintStatus, getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { generateUuid8 } from '@src/utils/ids.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { DependencyCycleError, TaskNotFoundError } from '@src/errors.ts';

export { TaskNotFoundError, DependencyCycleError } from '@src/errors.ts';

export async function getTasks(sprintId?: string): Promise<Tasks> {
  const id = await resolveSprintId(sprintId);
  const result = await readValidatedJson(getTasksFilePath(id), TasksSchema);
  if (!result.ok) throw result.error;
  return result.value;
}

export async function saveTasks(tasks: Tasks, sprintId?: string): Promise<void> {
  const id = await resolveSprintId(sprintId);
  const result = await writeValidatedJson(getTasksFilePath(id), tasks, TasksSchema);
  if (!result.ok) throw result.error;
}

export async function getTask(taskId: string, sprintId?: string): Promise<Task> {
  const tasks = await getTasks(sprintId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  return task;
}

export interface AddTaskInput {
  name: string;
  description?: string;
  steps?: string[];
  ticketId?: string;
  blockedBy?: string[];
  projectPath: string;
}

export async function addTask(input: AddTaskInput, sprintId?: string): Promise<Task> {
  const id = await resolveSprintId(sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be draft to add tasks
  assertSprintStatus(sprint, ['draft'], 'add tasks');

  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    const maxOrder = tasks.reduce((max, t) => Math.max(max, t.order), 0);

    const task: Task = {
      id: generateUuid8(),
      name: input.name,
      description: input.description,
      steps: input.steps ?? [],
      status: 'todo',
      order: maxOrder + 1,
      ticketId: input.ticketId,
      blockedBy: input.blockedBy ?? [],
      projectPath: input.projectPath,
      verified: false,
    };

    tasks.push(task);
    await saveTasks(tasks, id);
    return task;
  });
  if (!lockResult.ok) throw lockResult.error;
  return lockResult.value;
}

export async function removeTask(taskId: string, sprintId?: string): Promise<void> {
  const id = await resolveSprintId(sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be draft to remove tasks
  assertSprintStatus(sprint, ['draft'], 'remove tasks');

  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index === -1) {
      throw new TaskNotFoundError(taskId);
    }
    tasks.splice(index, 1);
    await saveTasks(tasks, id);
  });
  if (!lockResult.ok) throw lockResult.error;
}

export async function updateTaskStatus(taskId: string, status: TaskStatus, sprintId?: string): Promise<Task> {
  const id = await resolveSprintId(sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be active to update task status
  assertSprintStatus(sprint, ['active'], 'update task status');

  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    task.status = status;
    await saveTasks(tasks, id);
    return task;
  });
  if (!lockResult.ok) throw lockResult.error;
  return lockResult.value;
}

export interface UpdateTaskInput {
  verified?: boolean;
  verificationOutput?: string;
}

export async function updateTask(taskId: string, updates: UpdateTaskInput, sprintId?: string): Promise<Task> {
  const id = await resolveSprintId(sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be active to update task
  assertSprintStatus(sprint, ['active'], 'update task');

  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (updates.verified !== undefined) {
      task.verified = updates.verified;
    }
    if (updates.verificationOutput !== undefined) {
      task.verificationOutput = updates.verificationOutput;
    }

    await saveTasks(tasks, id);
    return task;
  });
  if (!lockResult.ok) throw lockResult.error;
  return lockResult.value;
}

/**
 * Check if a task is blocked by dependencies.
 * A task is blocked if any of its blockedBy tasks are not done.
 */
export async function isTaskBlocked(taskId: string, sprintId?: string): Promise<boolean> {
  const tasks = await getTasks(sprintId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return false;

  if (task.blockedBy.length === 0) return false;

  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return !task.blockedBy.every((id) => doneIds.has(id));
}

export async function getNextTask(sprintId?: string): Promise<Task | null> {
  const tasks = await getTasks(sprintId);

  // Priority 1: Resume in_progress task
  const inProgress = tasks.find((t) => t.status === 'in_progress');
  if (inProgress) {
    return inProgress;
  }

  // Priority 2: First todo task whose dependencies are all done
  const ready = getReadyTasksFromList(tasks);
  return ready[0] ?? null;
}

/**
 * Get all tasks from a task list that are ready to execute (unblocked todo tasks).
 * Pure function operating on an in-memory list.
 */
export function getReadyTasksFromList(tasks: Tasks): Tasks {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks
    .filter((t) => t.status === 'todo')
    .filter((t) => t.blockedBy.every((id) => doneIds.has(id)))
    .sort((a, b) => a.order - b.order);
}

/**
 * Get all tasks that are ready to execute (unblocked todo tasks).
 * Returns multiple tasks for parallel execution.
 */
export async function getReadyTasks(sprintId?: string): Promise<Tasks> {
  const tasks = await getTasks(sprintId);
  return getReadyTasksFromList(tasks);
}

export async function reorderTask(taskId: string, newOrder: number, sprintId?: string): Promise<Task> {
  const id = await resolveSprintId(sprintId);
  const sprint = await getSprint(id);

  // Check sprint status - must be draft to reorder tasks
  assertSprintStatus(sprint, ['draft'], 'reorder tasks');

  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    const oldOrder = task.order;
    task.order = newOrder;

    // Adjust other task orders
    for (const t of tasks) {
      if (t.id === taskId) continue;

      if (oldOrder < newOrder) {
        // Moving down: decrement tasks between old and new positions
        if (t.order > oldOrder && t.order <= newOrder) {
          t.order--;
        }
      } else {
        // Moving up: increment tasks between new and old positions
        if (t.order >= newOrder && t.order < oldOrder) {
          t.order++;
        }
      }
    }

    await saveTasks(tasks, id);
    return task;
  });
  if (!lockResult.ok) throw lockResult.error;
  return lockResult.value;
}

export async function listTasks(sprintId?: string): Promise<Tasks> {
  const tasks = await getTasks(sprintId);
  return tasks.sort((a, b) => a.order - b.order);
}

export async function getRemainingTasks(sprintId?: string): Promise<Tasks> {
  const tasks = await getTasks(sprintId);
  return tasks.filter((t) => t.status !== 'done').sort((a, b) => a.order - b.order);
}

export async function areAllTasksDone(sprintId?: string): Promise<boolean> {
  const tasks = await getTasks(sprintId);
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}

/**
 * Performs topological sort on tasks based on blockedBy dependencies.
 * Returns tasks in dependency order (tasks that block others come first).
 * Throws DependencyCycleError if a cycle is detected.
 */
export function topologicalSort(tasks: Tasks): Tasks {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: Task[] = [];

  function visit(taskId: string, path: string[]): void {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      // Found a cycle - find where in path it starts
      const cycleStart = path.indexOf(taskId);
      throw new DependencyCycleError([...path.slice(cycleStart), taskId]);
    }

    const task = taskMap.get(taskId);
    if (!task) return;

    visiting.add(taskId);

    // Visit all tasks this one depends on first
    for (const blockedById of task.blockedBy) {
      visit(blockedById, [...path, taskId]);
    }

    visiting.delete(taskId);
    visited.add(taskId);
    result.push(task);
  }

  for (const task of tasks) {
    visit(task.id, []);
  }

  return result;
}

/**
 * Reorders tasks by dependencies and updates their order field.
 * Called at sprint start to ensure task order respects dependencies.
 */
export async function reorderByDependencies(sprintId?: string): Promise<void> {
  const id = await resolveSprintId(sprintId);
  const tasksFilePath = getTasksFilePath(id);

  // Use file lock for atomic read-modify-write
  const lockResult = await withFileLock(tasksFilePath, async () => {
    const tasks = await getTasks(id);
    if (tasks.length === 0) return;

    const sorted = topologicalSort(tasks);

    // Update order field based on sorted position
    sorted.forEach((task, index) => {
      task.order = index + 1;
    });

    await saveTasks(sorted, id);
  });
  if (!lockResult.ok) throw lockResult.error;
}

/**
 * Validates import tasks for dependency issues and ticketId references.
 * Tasks can have a local 'id' field that blockedBy references.
 * If ticketIds is provided, validates that ticketId references exist.
 * Returns an array of error messages (empty if valid).
 */
export function validateImportTasks(
  importTasks: { id?: string; name: string; blockedBy?: string[]; ticketId?: string }[],
  existingTasks: Tasks,
  ticketIds?: Set<string>
): string[] {
  const errors: string[] = [];

  // Validate ticketId references if ticket IDs are provided
  if (ticketIds) {
    for (const task of importTasks) {
      if (task.ticketId && !ticketIds.has(task.ticketId)) {
        errors.push(`Task "${task.name}": ticketId "${task.ticketId}" does not match any ticket in the sprint`);
      }
    }
  }

  // Build set of all known IDs (local IDs from import + existing task IDs)
  const localIds = new Set(importTasks.map((t) => t.id).filter((id): id is string => !!id));
  const existingIds = new Set(existingTasks.map((t) => t.id));
  const allKnownIds = new Set([...localIds, ...existingIds]);

  // Build map of local ID to array index for ordering check
  const localIdToIndex = new Map<string, number>();
  importTasks.forEach((task, i) => {
    if (task.id) {
      localIdToIndex.set(task.id, i);
    }
  });

  // Validate blockedBy references
  importTasks.forEach((task, taskIndex) => {
    for (const depId of task.blockedBy ?? []) {
      if (!allKnownIds.has(depId)) {
        errors.push(`Task "${task.name}": blockedBy "${depId}" does not exist`);
      } else if (localIds.has(depId)) {
        // If referencing a local ID, it must appear earlier in the import array
        const depIndex = localIdToIndex.get(depId);
        if (depIndex !== undefined && depIndex >= taskIndex) {
          errors.push(`Task "${task.name}": blockedBy "${depId}" must reference an earlier task in the import`);
        }
      }
    }
  });

  if (errors.length > 0) {
    return errors;
  }

  // Generate temporary real IDs for cycle detection
  const tempRealIds = importTasks.map(() => generateUuid8());

  // Map local IDs to temp real IDs
  const localToTempReal = new Map<string, string>();
  importTasks.forEach((task, i) => {
    if (task.id) {
      localToTempReal.set(task.id, tempRealIds[i] ?? '');
    }
  });

  // Build combined task list for cycle detection
  const combinedTasks: Tasks = [
    ...existingTasks,
    ...importTasks.map((t, i) => ({
      id: tempRealIds[i] ?? generateUuid8(),
      name: t.name,
      description: undefined,
      steps: [],
      status: 'todo' as const,
      order: existingTasks.length + i + 1,
      ticketId: undefined,
      blockedBy: (t.blockedBy ?? []).map((depId) => {
        // Convert local ID to temp real ID, or keep existing ID
        return localToTempReal.get(depId) ?? depId;
      }),
      projectPath: '/tmp', // Placeholder for validation only
      verified: false,
    })),
  ];

  // Check for cycles using topologicalSort (throws DependencyCycleError on cycle)
  try {
    topologicalSort(combinedTasks);
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  return errors;
}
