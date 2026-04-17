import {
  getProgressFilePath,
  getSprintDir,
  getSprintFilePath,
  getSprintsDir,
  getTasksFilePath,
} from '@src/integration/persistence/paths.ts';
import {
  appendToFile,
  ensureDir,
  fileExists,
  listDirs,
  readValidatedJson,
  removeDir,
  writeValidatedJson,
} from '@src/integration/persistence/storage.ts';
import { type Sprint, SprintSchema, type SprintStatus, type Tasks, TasksSchema } from '@src/domain/models.ts';
import { getCurrentSprint } from '@src/integration/persistence/config.ts';
import { generateSprintId } from '@src/domain/ids.ts';
import { logBaselines } from '@src/integration/persistence/progress.ts';
import { NoCurrentSprintError, SprintNotFoundError, SprintStatusError } from '@src/domain/errors.ts';

export { SprintNotFoundError, SprintStatusError, NoCurrentSprintError } from '@src/domain/errors.ts';

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

export interface CreateSprintInput {
  readonly projectId: string;
  readonly name?: string;
}

export async function createSprint(input: CreateSprintInput): Promise<Sprint> {
  const { projectId, name } = input;
  const id = generateSprintId(name);
  const now = new Date().toISOString();

  // Use the slug portion of the ID as display name if no name provided
  const displayName = name ?? id.slice(16); // Skip "YYYYMMDD-HHmmss-" prefix

  const sprint: Sprint = {
    id,
    name: displayName,
    projectId,
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

  const writeSprintResult = await writeValidatedJson(getSprintFilePath(id), sprint, SprintSchema);
  if (!writeSprintResult.ok) throw writeSprintResult.error;

  const writeTasksResult = await writeValidatedJson(getTasksFilePath(id), [], TasksSchema);
  if (!writeTasksResult.ok) throw writeTasksResult.error;

  const appendResult = await appendToFile(
    getProgressFilePath(id),
    `# Sprint: ${displayName}\n\nCreated: ${now}\n\n---\n\n`
  );
  if (!appendResult.ok) throw appendResult.error;

  return sprint;
}

export async function getSprint(sprintId: string): Promise<Sprint> {
  const sprintPath = getSprintFilePath(sprintId);
  if (!(await fileExists(sprintPath))) {
    throw new SprintNotFoundError(sprintId);
  }
  const result = await readValidatedJson(sprintPath, SprintSchema);
  if (!result.ok) throw result.error;
  return result.value;
}

export async function saveSprint(sprint: Sprint): Promise<void> {
  const result = await writeValidatedJson(getSprintFilePath(sprint.id), sprint, SprintSchema);
  if (!result.ok) throw result.error;
}

export async function listSprints(): Promise<Sprint[]> {
  const sprintsDir = getSprintsDir();
  const dirs = await listDirs(sprintsDir);

  const sprints: Sprint[] = [];
  for (const dir of dirs) {
    const sprintPath = getSprintFilePath(dir);
    if (!(await fileExists(sprintPath))) continue; // Skip missing sprint files
    const result = await readValidatedJson(sprintPath, SprintSchema);
    if (!result.ok) continue; // Skip invalid/corrupt sprint directories
    sprints.push(result.value);
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

  // Log baseline git state for each unique repo touched by the sprint's tasks.
  // Caller-side resolution (persistence is synchronous about ids; resolving
  // repoId → path happens in the execute pipeline where the project graph is
  // already loaded). `logBaselines` is only invoked from there now.
  const tasksResult = await readValidatedJson(getTasksFilePath(sprintId), TasksSchema);
  if (!tasksResult.ok) throw tasksResult.error;
  const _tasks: Tasks = tasksResult.value;
  void _tasks;

  return sprint;
}

/**
 * Resolve repoIds for an activated sprint's tasks and log git baselines.
 * Split from `activateSprint` because persistence shouldn't reach into the
 * project graph — callers (the execute pipeline) own that concern.
 */
export async function logSprintBaselines(
  sprint: Sprint,
  resolvePath: (repoId: string) => Promise<string | null>
): Promise<void> {
  const tasksResult = await readValidatedJson(getTasksFilePath(sprint.id), TasksSchema);
  if (!tasksResult.ok) throw tasksResult.error;
  const repoIds = [...new Set(tasksResult.value.map((t) => t.repoId))];
  const paths: string[] = [];
  for (const repoId of repoIds) {
    const p = await resolvePath(repoId);
    if (p) paths.push(p);
  }
  if (paths.length > 0) {
    await logBaselines({ sprintId: sprint.id, sprintName: sprint.name, projectPaths: paths });
  }
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
    throw new NoCurrentSprintError();
  }
  return getSprint(currentSprintId);
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
