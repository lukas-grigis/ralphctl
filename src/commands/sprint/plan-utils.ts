import { readFile } from 'node:fs/promises';
import { muted, success } from '@src/theme/index.ts';
import { log, renderTable } from '@src/theme/ui.ts';
import { addTask, getTasks, saveTasks } from '@src/store/task.ts';
import { getSchemaPath, getTasksFilePath } from '@src/utils/paths.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { type ImportTask, ImportTasksSchema } from '@src/schemas/index.ts';
import { extractJsonArray } from '@src/utils/json-extract.ts';

/**
 * Load the task import JSON schema from file.
 */
export async function getTaskImportSchema(): Promise<string> {
  const schemaPath = getSchemaPath('task-import.schema.json');
  return readFile(schemaPath, 'utf-8');
}

/**
 * Check if Claude output contains a planning-blocked signal.
 * Returns the reason if blocked, null otherwise.
 */
export function parsePlanningBlocked(output: string): string | null {
  const match = /<planning-blocked>([\s\S]*?)<\/planning-blocked>/.exec(output);
  return match?.[1]?.trim() ?? null;
}

/**
 * Parse Claude output to extract and validate task JSON array.
 */
export function parseTasksJson(output: string): ImportTask[] {
  // Try to extract a balanced JSON array from the output (handles nested arrays like steps)
  const jsonStr = extractJsonArray(output);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
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
 * Returns the number of successfully imported tasks.
 */
export async function importTasks(tasks: ImportTask[], sprintId: string): Promise<number> {
  // Build mapping from local IDs to real IDs
  const localToRealId = new Map<string, string>();

  // First pass: create all tasks and build ID mapping
  const createdTasks: { task: ImportTask; realId: string }[] = [];

  for (const taskInput of tasks) {
    try {
      // projectPath is now required from Claude
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

      // Map local ID to real ID
      if (taskInput.id) {
        localToRealId.set(taskInput.id, task.id);
      }

      createdTasks.push({ task: taskInput, realId: task.id });
      console.log(success(`  + ${task.id}: ${task.name}`));
    } catch (err) {
      log.itemError(`Failed to add: ${taskInput.name}`);
      if (err instanceof Error) {
        console.log(muted(`    ${err.message}`));
      }
    }
  }

  // Second pass: update blockedBy with resolved real IDs (under file lock)
  const tasksFilePath = getTasksFilePath(sprintId);
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
  });

  return createdTasks.length;
}
