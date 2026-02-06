import { readFile } from 'node:fs/promises';
import { error, info, muted, success } from '@src/theme/index.ts';
import { addTask, getTasks, saveTasks, validateImportTasks } from '@src/store/task.ts';
import { SprintStatusError, resolveSprintId } from '@src/store/sprint.ts';
import { ImportTasksSchema } from '@src/schemas/index.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { getTasksFilePath } from '@src/utils/paths.ts';

export async function taskImportCommand(args: string[]): Promise<void> {
  const filePath = args[0];

  if (!filePath) {
    console.log(error('\nFile path required.'));
    console.log(muted('Usage: ralphctl task import <file.json>'));
    console.log(muted('\nExpected JSON format:'));
    console.log(
      muted(`[
  {
    "id": "1",
    "name": "Task name",
    "projectPath": "/path/to/repo",
    "description": "Optional description",
    "steps": ["Step 1", "Step 2"],
    "ticketId": "abc12345",
    "blockedBy": ["task-001"]
  }
]`)
    );
    console.log(muted('\nNote: projectPath is required for each task.'));
    console.log('');
    return;
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.log(error(`\nFailed to read file: ${filePath}\n`));
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    console.log(error('\nInvalid JSON format.\n'));
    return;
  }

  const result = ImportTasksSchema.safeParse(data);
  if (!result.success) {
    console.log(error('\nInvalid task format:'));
    for (const issue of result.error.issues) {
      console.log(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    console.log('');
    return;
  }

  const tasks = result.data;
  if (tasks.length === 0) {
    console.log(error('\nNo tasks to import.\n'));
    return;
  }

  // Validate dependencies before importing
  const existingTasks = await getTasks();
  const validationErrors = validateImportTasks(tasks, existingTasks);
  if (validationErrors.length > 0) {
    console.log(error('\nDependency validation failed:'));
    for (const err of validationErrors) {
      console.log(`  - ${err}`);
    }
    console.log('');
    return;
  }

  console.log(info(`\nImporting ${String(tasks.length)} task(s)...\n`));

  // Build local ID to real ID mapping
  const localToRealId = new Map<string, string>();
  const createdTasks: { task: (typeof tasks)[0]; realId: string }[] = [];

  // First pass: create tasks without blockedBy
  let imported = 0;
  for (const taskInput of tasks) {
    try {
      // projectPath is required from the schema
      const task = await addTask({
        name: taskInput.name,
        description: taskInput.description,
        steps: taskInput.steps ?? [],
        ticketId: taskInput.ticketId,
        blockedBy: [], // Set later
        projectPath: taskInput.projectPath,
      });

      // Map local ID to real ID
      if (taskInput.id) {
        localToRealId.set(taskInput.id, task.id);
      }

      createdTasks.push({ task: taskInput, realId: task.id });
      console.log(success(`  + ${task.id}: ${task.name}`));
      imported++;
    } catch (err) {
      if (err instanceof SprintStatusError) {
        console.log(error(`\n${err.message}\n`));
        return;
      }
      console.log(error(`  ! Failed to add: ${taskInput.name}`));
      if (err instanceof Error) {
        console.log(muted(`    ${err.message}`));
      }
    }
  }

  // Second pass: update blockedBy with resolved real IDs (under file lock)
  const sprintId = await resolveSprintId();
  const tasksFilePath = getTasksFilePath(sprintId);
  await withFileLock(tasksFilePath, async () => {
    const allTasks = await getTasks();
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
    await saveTasks(allTasks);
  });

  console.log(info(`\nImported ${String(imported)}/${String(tasks.length)} tasks.\n`));
}
