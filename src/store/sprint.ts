import {
  getProgressFilePath,
  getSprintDir,
  getSprintFilePath,
  getSprintsDir,
  getTasksFilePath,
} from '@src/utils/paths.ts';
import {
  appendToFile,
  ensureDir,
  fileExists,
  listDirs,
  readValidatedJson,
  removeDir,
  ValidationError,
  writeValidatedJson,
} from '@src/utils/storage.ts';
import { type Sprint, SprintSchema, type SprintStatus, type Tasks, TasksSchema } from '@src/schemas/index.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { generateSprintId } from '@src/utils/ids.ts';
import { logBaselines } from '@src/store/progress.ts';

export class SprintNotFoundError extends Error {
  public readonly sprintId: string;

  constructor(sprintId: string) {
    super(`Sprint not found: ${sprintId}`);
    this.name = 'SprintNotFoundError';
    this.sprintId = sprintId;
  }
}

export class SprintStatusError extends Error {
  public readonly currentStatus: SprintStatus;
  public readonly operation: string;

  constructor(message: string, currentStatus: SprintStatus, operation: string) {
    super(message);
    this.name = 'SprintStatusError';
    this.currentStatus = currentStatus;
    this.operation = operation;
  }
}

export class NoCurrentSprintError extends Error {
  constructor() {
    super('No sprint specified and no current sprint set.');
    this.name = 'NoCurrentSprintError';
  }
}

/**
 * Assert that a sprint is in one of the allowed statuses for an operation.
 * @throws SprintStatusError if status is not allowed
 */
export function assertSprintStatus(
  sprint: Sprint,
  allowedStatuses: SprintStatus[],
  operation: string
): asserts sprint is Sprint {
  if (!allowedStatuses.includes(sprint.status)) {
    const statusText = allowedStatuses.join(' or ');
    const hints: Record<string, string> = {
      'add tickets': 'Close the current sprint and create a new one for additional work.',
      'remove tickets': 'Sprint must be in draft status to remove tickets.',
      'add tasks': 'Close the current sprint and create a new one for additional work.',
      'remove tasks': 'Sprint must be in draft status to remove tasks.',
      'reorder tasks': 'Sprint must be in draft status to reorder tasks.',
      refine: 'Refinement can only be done on draft sprints.',
      plan: 'Planning can only be done on draft sprints.',
      activate: 'Sprint must be in draft status to activate.',
      start: 'Sprint must be draft or active to start.',
      'update task status': 'Task status can only be updated during active execution.',
      'log progress': 'Progress can only be logged during active execution.',
      close: 'Sprint must be active to close.',
    };

    const hint = hints[operation] ?? '';
    const hintText = hint ? `\nHint: ${hint}` : '';

    throw new SprintStatusError(
      `Cannot ${operation}: sprint status is '${sprint.status}' (must be ${statusText}).${hintText}`,
      sprint.status,
      operation
    );
  }
}

export async function createSprint(name?: string): Promise<Sprint> {
  const id = generateSprintId(name);
  const now = new Date().toISOString();

  // Use the slug portion of the ID as display name if no name provided
  const displayName = name ?? id.slice(16); // Skip "YYYYMMDD-HHmmss-" prefix

  const sprint: Sprint = {
    id,
    name: displayName,
    status: 'draft',
    createdAt: now,
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };

  const sprintDir = getSprintDir(id);
  await ensureDir(sprintDir);

  await writeValidatedJson(getSprintFilePath(id), sprint, SprintSchema);
  await writeValidatedJson(getTasksFilePath(id), [], TasksSchema);
  await appendToFile(getProgressFilePath(id), `# Sprint: ${displayName}\n\nCreated: ${now}\n\n---\n\n`);

  return sprint;
}

/**
 * Find the sprint with status='active' (if any).
 * Returns null if no sprint is currently active.
 */
export async function findActiveSprint(): Promise<Sprint | null> {
  const sprints = await listSprints();
  return sprints.find((s) => s.status === 'active') ?? null;
}

export async function getSprint(sprintId: string): Promise<Sprint> {
  const sprintPath = getSprintFilePath(sprintId);
  if (!(await fileExists(sprintPath))) {
    throw new SprintNotFoundError(sprintId);
  }
  return readValidatedJson(sprintPath, SprintSchema);
}

export async function saveSprint(sprint: Sprint): Promise<void> {
  await writeValidatedJson(getSprintFilePath(sprint.id), sprint, SprintSchema);
}

export async function listSprints(): Promise<Sprint[]> {
  const sprintsDir = getSprintsDir();
  const dirs = await listDirs(sprintsDir);

  const sprints: Sprint[] = [];
  for (const dir of dirs) {
    try {
      const sprint = await getSprint(dir);
      sprints.push(sprint);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof SprintNotFoundError) {
        continue; // Skip invalid/corrupt sprint directories
      }
      throw err;
    }
  }

  // Sort by creation date (newest first)
  return sprints.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function activateSprint(sprintId: string): Promise<Sprint> {
  const sprint = await getSprint(sprintId);

  assertSprintStatus(sprint, ['draft'], 'activate');

  sprint.status = 'active';
  sprint.activatedAt = new Date().toISOString();
  await saveSprint(sprint);

  // Log baseline git state for each unique project path
  const tasks: Tasks = await readValidatedJson(getTasksFilePath(sprintId), TasksSchema);
  const projectPaths = tasks.map((t) => t.projectPath).filter((p): p is string => !!p);

  if (projectPaths.length > 0) {
    await logBaselines({
      sprintId,
      sprintName: sprint.name,
      projectPaths,
    });
  }

  return sprint;
}

export async function closeSprint(sprintId: string): Promise<Sprint> {
  const sprint = await getSprint(sprintId);

  assertSprintStatus(sprint, ['active'], 'close');

  sprint.status = 'closed';
  sprint.closedAt = new Date().toISOString();
  sprint.checkRanAt = {};
  await saveSprint(sprint);

  return sprint;
}

export async function deleteSprint(sprintId: string): Promise<Sprint> {
  const sprint = await getSprint(sprintId);
  const sprintDir = getSprintDir(sprintId);
  await removeDir(sprintDir);
  return sprint;
}

export async function getCurrentSprintOrThrow(): Promise<Sprint> {
  const currentSprintId = await getCurrentSprint();
  if (!currentSprintId) {
    throw new Error('No current sprint. Use "ralphctl sprint create" to create one.');
  }
  return getSprint(currentSprintId);
}

export async function getActiveSprintOrThrow(): Promise<Sprint> {
  const activeSprint = await findActiveSprint();
  if (!activeSprint) {
    throw new Error('No active sprint. Use "ralphctl sprint start" to start a draft sprint.');
  }
  return activeSprint;
}

export async function resolveSprintId(sprintId?: string): Promise<string> {
  if (sprintId) {
    return sprintId;
  }
  const currentSprintId = await getCurrentSprint();
  if (!currentSprintId) {
    throw new NoCurrentSprintError();
  }
  return currentSprintId;
}
