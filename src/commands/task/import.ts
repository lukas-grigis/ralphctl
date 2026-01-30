import { readFile } from 'node:fs/promises';
import { success, info, error, muted } from '@src/utils/colors.ts';
import { addTask } from '@src/services/task.ts';
import { z } from 'zod';

const ImportTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
  ticketId: z.string().optional(),
});

const ImportTasksSchema = z.array(ImportTaskSchema);

export async function taskImportCommand(args: string[]): Promise<void> {
  const filePath = args[0];

  if (!filePath) {
    console.log(error('\nFile path required.'));
    console.log(muted('Usage: ralphctl task import <file.json>'));
    console.log(muted('\nExpected JSON format:'));
    console.log(
      muted(`[
  {
    "name": "Task name",
    "description": "Optional description",
    "steps": ["Step 1", "Step 2"],
    "ticketId": "TICKET-001"
  }
]`)
    );
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

  console.log(info(`\nImporting ${String(tasks.length)} task(s)...\n`));

  let imported = 0;
  for (const taskInput of tasks) {
    try {
      const task = await addTask({
        name: taskInput.name,
        description: taskInput.description,
        steps: taskInput.steps ?? [],
        ticketId: taskInput.ticketId,
      });
      console.log(success(`  + ${task.id}: ${task.name}`));
      imported++;
    } catch (err) {
      console.log(error(`  ! Failed to add: ${taskInput.name}`));
      if (err instanceof Error) {
        console.log(muted(`    ${err.message}`));
      }
    }
  }

  console.log(info(`\nImported ${String(imported)}/${String(tasks.length)} tasks.\n`));
}
