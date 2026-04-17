import { readFile } from 'node:fs/promises';
import { renderTable } from '@src/integration/ui/theme/ui.ts';
import { addTask, getTasks, saveTasks } from '@src/integration/persistence/task.ts';
import { getSchemaPath, getTasksFilePath } from '@src/integration/persistence/paths.ts';
import { withFileLock } from '@src/integration/persistence/file-lock.ts';
import { ensureError, unwrapOrThrow, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { type ImportTask, ImportTasksSchema, type Task } from '@src/domain/models.ts';
import { extractJsonArray } from '@src/integration/utils/json-extract.ts';
import { generateUuid8 } from '@src/domain/ids.ts';

/**
 * Load the task import JSON schema from file.
 */
export async function getTaskImportSchema(): Promise<string> {
  const schemaPath = getSchemaPath('task-import.schema.json');
  return readFile(schemaPath, 'utf-8');
}

/**
 * Check if AI output contains a planning-blocked signal.
 * Returns the reason if blocked, null otherwise.
 */
export function parsePlanningBlocked(output: string): string | null {
  const match = /<planning-blocked>([\s\S]*?)<\/planning-blocked>/.exec(output);
  return match?.[1]?.trim() ?? null;
}

/**
 * Build provider-neutral headless spawn options for sprint planning/ideation.
 *
 * Provider-specific headless flags (for example Claude's `--output-format json`
 * or Copilot's `--autopilot`) are added by the provider adapter inside
 * spawnHeadless(). This helper only adds repo access flags and passes the prompt
 * separately via stdin.
 */
export function buildHeadlessAiRequest(
  repoPaths: string[],
  prompt: string
): {
  args: string[];
  prompt: string;
} {
  return {
    args: repoPaths.flatMap((path) => ['--add-dir', path]),
    prompt,
  };
}

/**
 * Parse AI output to extract and validate task JSON array.
 */
export function parseTasksJson(output: string): ImportTask[] {
  // Try to extract a balanced JSON array from the output (handles nested arrays like steps)
  const jsonStr = extractJsonArray(output);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`, { cause: err });
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }

  // Validate against schema
  const result = ImportTasksSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `[${issue.path.join('.')}]` : '';
        return `  ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid task format:\n${issues}`);
  }

  return result.data;
}

/**
 * Render parsed tasks as a formatted table.
 */
export function renderParsedTasksTable(parsedTasks: ImportTask[]): string {
  const rows = parsedTasks.map((task, i) => {
    const deps = task.blockedBy?.length ? task.blockedBy.join(', ') : '';
    return [String(i + 1), task.name, task.projectPath, deps];
  });
  return renderTable(
    [{ header: '#', align: 'right' as const }, { header: 'Name' }, { header: 'Path' }, { header: 'Blocked By' }],
    rows
  );
}

/**
 * Import tasks with two-pass ID resolution.
 * When `replace: true`, builds the complete task list in memory and writes atomically
 * (interruption-safe: original tasks.json untouched until final write).
 * When `replace: false` (default), appends via addTask() one-by-one.
 * Returns the number of successfully imported tasks.
 */
export async function importTasks(
  tasks: ImportTask[],
  sprintId: string,
  options?: { replace?: boolean }
): Promise<number> {
  if (options?.replace) {
    return importTasksReplace(tasks, sprintId);
  }

  return importTasksAppend(tasks, sprintId);
}

/**
 * Append tasks one-by-one via addTask() (first plan — no existing tasks).
 */
async function importTasksAppend(tasks: ImportTask[], sprintId: string): Promise<number> {
  // Build mapping from local IDs to real IDs
  const localToRealId = new Map<string, string>();

  // First pass: create all tasks and build ID mapping
  const createdTasks: { task: ImportTask; realId: string }[] = [];

  for (const taskInput of tasks) {
    const addR = await wrapAsync(async () => {
      const projectPath = taskInput.projectPath;

      // Create task without blockedBy first
      const task = await addTask(
        {
          name: taskInput.name,
          description: taskInput.description,
          steps: taskInput.steps ?? [],
          ticketId: taskInput.ticketId,
          blockedBy: [], // Set later
          projectPath,
        },
        sprintId
      );

      return task;
    }, ensureError);

    if (addR.ok) {
      const task = addR.value;
      // Map local ID to real ID
      if (taskInput.id) {
        localToRealId.set(taskInput.id, task.id);
      }
      createdTasks.push({ task: taskInput, realId: task.id });
    }
    // Failures are surfaced via the returned count (caller compares against input length);
    // no direct stdout writes here — this helper is called from the Ink TUI pipeline path.
  }

  // Second pass: update blockedBy with resolved real IDs (under file lock)
  const tasksFilePath = getTasksFilePath(sprintId);
  unwrapOrThrow(
    await withFileLock(tasksFilePath, async () => {
      const allTasks = await getTasks(sprintId);
      for (const { task: taskInput, realId } of createdTasks) {
        const blockedBy = (taskInput.blockedBy ?? [])
          .map((localId) => localToRealId.get(localId) ?? '')
          .filter((id) => id !== '');

        if (blockedBy.length > 0) {
          const taskToUpdate = allTasks.find((t) => t.id === realId);
          if (taskToUpdate) {
            taskToUpdate.blockedBy = blockedBy;
          }
        }
      }
      await saveTasks(allTasks, sprintId);
    })
  );

  return createdTasks.length;
}

/**
 * Build the complete task list in memory and write atomically via saveTasks().
 * Original tasks.json is untouched until the final write — interruption-safe.
 */
async function importTasksReplace(tasks: ImportTask[], sprintId: string): Promise<number> {
  // Build mapping from local IDs to real IDs
  const localToRealId = new Map<string, string>();
  const newTasks: Task[] = [];

  // First pass: generate real IDs and build mapping
  for (const taskInput of tasks) {
    const realId = generateUuid8();
    if (taskInput.id) {
      localToRealId.set(taskInput.id, realId);
    }

    newTasks.push({
      id: realId,
      name: taskInput.name,
      description: taskInput.description,
      steps: taskInput.steps ?? [],
      verificationCriteria: taskInput.verificationCriteria ?? [],
      status: 'todo',
      order: newTasks.length + 1,
      ticketId: taskInput.ticketId,
      blockedBy: [], // Set in second pass
      projectPath: taskInput.projectPath,
      evaluated: false,
      verified: false,
    });
  }

  // Second pass: resolve blockedBy references
  for (let i = 0; i < tasks.length; i++) {
    const taskInput = tasks[i];
    const newTask = newTasks[i];
    if (!taskInput || !newTask) continue;

    const blockedBy = (taskInput.blockedBy ?? [])
      .map((localId) => localToRealId.get(localId) ?? '')
      .filter((id) => id !== '');

    newTask.blockedBy = blockedBy;
  }

  // Atomic write — replaces all existing tasks in one operation
  await saveTasks(newTasks, sprintId);

  return newTasks.length;
}
