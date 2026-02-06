import { readFile } from 'node:fs/promises';
import { error, muted } from '@src/theme/index.ts';
import { createSpinner, log, showError, showNextStep } from '@src/theme/ui.ts';
import { addTask, getTasks, saveTasks, validateImportTasks } from '@src/store/task.ts';
import { SprintStatusError, getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { ImportTasksSchema } from '@src/schemas/index.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { getTasksFilePath } from '@src/utils/paths.ts';

export async function taskImportCommand(args: string[]): Promise<void> {
  const filePath = args[0];

  if (!filePath) {
    showError('File path required.');
    showNextStep('ralphctl task import <file.json>', 'provide a task file');
    log.dim('Expected JSON format:');
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
    log.dim('Note: projectPath is required for each task.');
    log.newline();
    return;
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    showError(`Failed to read file: ${filePath}`);
    log.newline();
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    showError('Invalid JSON format.');
    log.newline();
    return;
  }

  const result = ImportTasksSchema.safeParse(data);
  if (!result.success) {
    showError('Invalid task format');
    for (const issue of result.error.issues) {
      log.item(error(`${issue.path.join('.')}: ${issue.message}`));
    }
    log.newline();
    return;
  }

  const tasks = result.data;
  if (tasks.length === 0) {
    showError('No tasks to import.');
    log.newline();
    return;
  }

  // Validate dependencies and ticketId references before importing
  const existingTasks = await getTasks();
  const sprintId = await resolveSprintId();
  const sprint = await getSprint(sprintId);
  const ticketIds = new Set(sprint.tickets.map((t) => t.id));
  const validationErrors = validateImportTasks(tasks, existingTasks, ticketIds);
  if (validationErrors.length > 0) {
    showError('Dependency validation failed');
    for (const err of validationErrors) {
      log.item(error(err));
    }
    log.newline();
    return;
  }

  // Build local ID to real ID mapping
  const localToRealId = new Map<string, string>();
  const createdTasks: { task: (typeof tasks)[0]; realId: string }[] = [];

  // First pass: create tasks without blockedBy
  const spinner = createSpinner(`Importing ${String(tasks.length)} task(s)...`).start();
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
      imported++;
      spinner.text = `Importing tasks... (${String(imported)}/${String(tasks.length)})`;
    } catch (err) {
      if (err instanceof SprintStatusError) {
        spinner.fail('Import failed');
        showError(err.message);
        log.newline();
        return;
      }
      log.itemError(`Failed to add: ${taskInput.name}`);
      if (err instanceof Error) {
        console.log(muted(`    ${err.message}`));
      }
    }
  }

  // Second pass: update blockedBy with resolved real IDs (under file lock)
  spinner.text = 'Resolving task dependencies...';
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

  spinner.succeed(`Imported ${String(imported)}/${String(tasks.length)} tasks`);
  for (const { task: taskInput, realId } of createdTasks) {
    log.itemSuccess(`${realId}: ${taskInput.name}`);
  }
}
