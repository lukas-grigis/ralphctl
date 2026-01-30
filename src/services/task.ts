import { getTasksFilePath } from '@src/utils/paths.ts';
import { readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { TasksSchema, type Task, type Tasks, type TaskStatus } from '@src/schemas/index.ts';
import { resolveScopeId } from '@src/services/scope.ts';

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStatusError';
  }
}

export async function getTasks(scopeId?: string): Promise<Tasks> {
  const id = await resolveScopeId(scopeId);
  return readValidatedJson(getTasksFilePath(id), TasksSchema);
}

export async function saveTasks(tasks: Tasks, scopeId?: string): Promise<void> {
  const id = await resolveScopeId(scopeId);
  await writeValidatedJson(getTasksFilePath(id), tasks, TasksSchema);
}

export async function getTask(taskId: string, scopeId?: string): Promise<Task> {
  const tasks = await getTasks(scopeId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  return task;
}

function generateTaskId(tasks: Tasks): string {
  const maxNum = tasks.reduce((max, t) => {
    const match = /^task-(\d+)$/.exec(t.id);
    if (match) {
      return Math.max(max, parseInt(match[1] ?? '0', 10));
    }
    return max;
  }, 0);
  return `task-${String(maxNum + 1).padStart(3, '0')}`;
}

export interface AddTaskInput {
  name: string;
  description?: string;
  steps?: string[];
  ticketId?: string;
}

export async function addTask(input: AddTaskInput, scopeId?: string): Promise<Task> {
  const tasks = await getTasks(scopeId);
  const maxOrder = tasks.reduce((max, t) => Math.max(max, t.order), 0);

  const task: Task = {
    id: generateTaskId(tasks),
    name: input.name,
    description: input.description,
    steps: input.steps ?? [],
    status: 'todo',
    order: maxOrder + 1,
    ticketId: input.ticketId,
  };

  tasks.push(task);
  await saveTasks(tasks, scopeId);
  return task;
}

export async function removeTask(taskId: string, scopeId?: string): Promise<void> {
  const tasks = await getTasks(scopeId);
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) {
    throw new TaskNotFoundError(taskId);
  }
  tasks.splice(index, 1);
  await saveTasks(tasks, scopeId);
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  scopeId?: string
): Promise<Task> {
  const tasks = await getTasks(scopeId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }

  task.status = status;
  await saveTasks(tasks, scopeId);
  return task;
}

export async function getNextTask(scopeId?: string): Promise<Task | null> {
  const tasks = await getTasks(scopeId);

  // First, check for any in_progress task (resumability)
  const inProgress = tasks.find((t) => t.status === 'in_progress');
  if (inProgress) {
    return inProgress;
  }

  // Otherwise, find the first todo task by order
  const todoTasks = tasks
    .filter((t) => t.status === 'todo')
    .sort((a, b) => a.order - b.order);

  return todoTasks[0] ?? null;
}

export async function reorderTask(
  taskId: string,
  newOrder: number,
  scopeId?: string
): Promise<Task> {
  const tasks = await getTasks(scopeId);
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

  await saveTasks(tasks, scopeId);
  return task;
}

export async function listTasks(scopeId?: string): Promise<Tasks> {
  const tasks = await getTasks(scopeId);
  return tasks.sort((a, b) => a.order - b.order);
}

export function formatTaskStatus(status: TaskStatus): string {
  const colors: Record<TaskStatus, string> = {
    todo: '\x1b[90m', // gray
    in_progress: '\x1b[33m', // yellow
    testing: '\x1b[36m', // cyan
    done: '\x1b[32m', // green
  };
  const reset = '\x1b[0m';
  return `${colors[status]}${status}${reset}`;
}

export async function getRemainingTasks(scopeId?: string): Promise<Tasks> {
  const tasks = await getTasks(scopeId);
  return tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => a.order - b.order);
}

export async function areAllTasksDone(scopeId?: string): Promise<boolean> {
  const tasks = await getTasks(scopeId);
  return tasks.length > 0 && tasks.every((t) => t.status === 'done');
}
