import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { error, info, muted, success, warning } from '@src/theme/index.ts';
import { assertSprintStatus, getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { addTask, getTasks, listTasks, saveTasks, validateImportTasks } from '@src/store/task.ts';
import {
  allRequirementsApproved,
  formatTicketDisplay,
  getPendingRequirements,
  groupTicketsByProject,
} from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getSchemaPath } from '@src/utils/paths.ts';
import { buildAutoPrompt, buildInteractivePrompt } from '@src/claude/prompts/index.ts';
import { spawnClaudeHeadless, spawnClaudeInteractive } from '@src/claude/session.ts';
import { ImportTasksSchema, type Repository, type Ticket } from '@src/schemas/index.ts';
import { selectProjectPaths } from '@src/interactive/selectors.ts';

async function getTaskImportSchema(): Promise<string> {
  const schemaPath = getSchemaPath('task-import.schema.json');
  return readFile(schemaPath, 'utf-8');
}

interface PlanOptions {
  auto: boolean;
  allPaths: boolean;
}

function parseArgs(args: string[]): { sprintId?: string; options: PlanOptions } {
  const options: PlanOptions = {
    auto: false,
    allPaths: false,
  };
  let sprintId: string | undefined;

  for (const arg of args) {
    if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '--all-paths') {
      options.allPaths = true;
    } else if (!arg.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

async function getSprintContext(
  sprintName: string,
  ticketsByProject: Map<string, Ticket[]>,
  existingTasks: { id: string; name: string; status: string; projectPath: string }[]
): Promise<string> {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprintName}`);

  // Group tickets by project in context
  for (const [projectName, tickets] of ticketsByProject) {
    lines.push('');
    lines.push(`## Project: ${projectName}`);

    // Get project repositories
    try {
      const project = await getProject(projectName);
      lines.push('');
      lines.push('### Repositories');
      for (const repo of project.repositories) {
        lines.push(`- **${repo.name}**: ${repo.path}`);
        if (repo.verifyScript) {
          lines.push(`  - Verify: \`${repo.verifyScript}\``);
        }
      }
    } catch {
      lines.push('Repositories: (project not found)');
    }
    lines.push('');
    lines.push('### Tickets');

    for (const ticket of tickets) {
      lines.push('');
      lines.push(`#### ${formatTicketDisplay(ticket)}`);

      if (ticket.description) {
        lines.push('');
        lines.push('**Original Description:**');
        lines.push(ticket.description);
      }
      if (ticket.link) {
        lines.push('');
        lines.push(`Link: ${ticket.link}`);
      }
      // Include refined requirements if available
      if (ticket.requirements) {
        lines.push('');
        lines.push('**Refined Requirements:**');
        lines.push('');
        lines.push(ticket.requirements);
      }
    }
  }

  if (existingTasks.length > 0) {
    lines.push('');
    lines.push('## Existing Tasks');
    lines.push('');
    for (const task of existingTasks) {
      lines.push(`- ${task.id}: ${task.name} [${task.status}] (${task.projectPath})`);
    }
  }

  return lines.join('\n');
}

async function invokeClaudeInteractive(prompt: string, primaryPath: string, additionalPaths: string[]): Promise<void> {
  // Write full context to a file for reference
  const contextFile = join(primaryPath, '.ralphctl-planning-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  // Count tickets in the prompt for the summary
  const ticketCount = (prompt.match(/^####/gm) ?? []).length;

  // Build initial prompt that tells Claude to read the context file
  const startPrompt = `I need help planning tasks for a sprint. The full planning context is in .ralphctl-planning-context.md (${String(ticketCount)} tickets). Please read that file now and follow the instructions to help me plan implementation tasks.`;

  // Build args for Claude session
  const args: string[] = [];
  for (const path of additionalPaths) {
    args.push('--add-dir', path);
  }

  const result = spawnClaudeInteractive(startPrompt, {
    cwd: primaryPath,
    args,
    env: {
      // Load CLAUDE.md from --add-dir paths too
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });

  // Clean up context file after session ends
  try {
    await unlink(contextFile);
  } catch {
    // Ignore cleanup errors
  }

  if (result.error) {
    throw new Error(result.error);
  }
}

async function invokeClaudeAuto(prompt: string, primaryPath: string, additionalPaths: string[]): Promise<string> {
  // Build args with --add-dir for additional paths and plan mode
  const args: string[] = ['--permission-mode', 'plan', '--print'];
  for (const path of additionalPaths) {
    args.push('--add-dir', path);
  }
  args.push('-p', prompt);

  return spawnClaudeHeadless({
    cwd: primaryPath,
    args,
    env: {
      // Load CLAUDE.md from --add-dir paths too
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });
}

interface ImportTask {
  id?: string; // Local ID for referencing in blockedBy
  name: string;
  description?: string;
  steps?: string[];
  ticketId?: string;
  blockedBy?: string[];
  projectPath: string; // Required - execution directory
}

function parseTasksJson(output: string): ImportTask[] {
  // Try to extract JSON from the output (in case there's extra text)
  const jsonMatch = /\[[\s\S]*\]/.exec(output);
  if (!jsonMatch) {
    throw new Error('No JSON array found in output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
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

async function importTasks(tasks: ImportTask[], sprintId: string): Promise<number> {
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
      console.log(error(`  ! Failed to add: ${taskInput.name}`));
      if (err instanceof Error) {
        console.log(muted(`    ${err.message}`));
      }
    }
  }

  // Second pass: update blockedBy with resolved real IDs
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

  return createdTasks.length;
}

export async function sprintPlanCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    console.log(warning('\nNo sprint specified and no current sprint set.'));
    console.log(muted('Specify a sprint ID or create one first.\n'));
    return;
  }

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to plan
  try {
    assertSprintStatus(sprint, ['draft'], 'plan');
  } catch (err) {
    if (err instanceof Error) {
      console.log(error(`\n${err.message}\n`));
    }
    return;
  }

  if (sprint.tickets.length === 0) {
    console.log(warning('\nNo tickets in sprint.'));
    console.log(muted('Add tickets first: ralphctl ticket add --project <project-name>\n'));
    return;
  }

  // Check if all tickets have approved requirements
  if (!allRequirementsApproved(sprint.tickets)) {
    const pendingTickets = getPendingRequirements(sprint.tickets);
    console.log(warning('\nNot all tickets have approved requirements.'));
    console.log(muted(`Pending: ${String(pendingTickets.length)} ticket(s)`));
    for (const ticket of pendingTickets) {
      console.log(muted(`  - ${formatTicketDisplay(ticket)}`));
    }
    console.log(muted('\nRun "ralphctl sprint refine" first.\n'));
    return;
  }

  // Group tickets by project
  const ticketsByProject = groupTicketsByProject(sprint.tickets);
  const tasks = await listTasks(id);

  console.log(info('\n=== Sprint Planning ==='));
  console.log(info('Sprint:  ') + sprint.name);
  console.log(info('ID:      ') + sprint.id);
  console.log(muted(`Tickets: ${String(sprint.tickets.length)}`));
  console.log(muted(`Projects: ${String(ticketsByProject.size)}`));
  console.log(muted(`Mode: ${options.auto ? 'Auto (headless)' : 'Interactive'}`));

  for (const [proj, tickets] of ticketsByProject) {
    console.log(muted(`  - ${proj}: ${String(tickets.length)} ticket(s)`));
  }
  console.log('');

  // Collect repositories by project for selection UI
  const reposByProject = new Map<string, Repository[]>();
  const defaultPaths: string[] = []; // First repo path per project

  for (const ticket of sprint.tickets) {
    if (reposByProject.has(ticket.projectName)) continue; // Already processed
    try {
      const project = await getProject(ticket.projectName);
      reposByProject.set(ticket.projectName, project.repositories);
      if (project.repositories[0]) defaultPaths.push(project.repositories[0].path);
    } catch {
      // Project not found, skip
    }
  }

  // Select which paths Claude should explore
  let selectedPaths: string[];
  const totalRepos = [...reposByProject.values()].reduce((n, repos) => n + repos.length, 0);

  if (options.allPaths) {
    // --all-paths: use all (opt-in to current slow behavior)
    selectedPaths = [...reposByProject.values()].flatMap((repos) => repos.map((r) => r.path));
  } else if (options.auto) {
    // --auto: use first repo per project (smart default)
    selectedPaths = defaultPaths;
  } else if (totalRepos === defaultPaths.length) {
    // Only one repo per project - no selection needed
    selectedPaths = defaultPaths;
  } else {
    // Multiple repos available - show checkbox
    selectedPaths = await selectProjectPaths(reposByProject);
  }

  const primaryPath = selectedPaths[0] ?? process.cwd();
  const additionalPaths = selectedPaths.slice(1);

  if (additionalPaths.length > 0) {
    console.log(muted(`Paths: ${primaryPath} + ${String(additionalPaths.length)} additional`));
  } else {
    console.log(muted(`Path: ${primaryPath}`));
  }

  const context = await getSprintContext(
    sprint.name,
    ticketsByProject,
    tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, projectPath: t.projectPath }))
  );
  const schema = await getTaskImportSchema();

  // Debug: show context size to verify content is being generated
  const contextLines = context.split('\n').length;
  const contextChars = context.length;
  console.log(muted(`Context: ${String(contextLines)} lines, ${String(contextChars)} chars`));

  if (options.auto) {
    // Headless mode - Claude generates and we import
    console.log(muted('Invoking Claude CLI (headless)...'));
    const prompt = buildAutoPrompt(context, schema);

    let output: string;
    try {
      output = await invokeClaudeAuto(prompt, primaryPath, additionalPaths);
    } catch (err) {
      if (err instanceof Error) {
        console.log(error(`\nFailed to invoke Claude: ${err.message}`));
        console.log(muted('Make sure the claude CLI is installed and configured.\n'));
      }
      return;
    }

    console.log(muted('Parsing response...'));
    let parsedTasks: ImportTask[];
    try {
      parsedTasks = parseTasksJson(output);
    } catch (err) {
      if (err instanceof Error) {
        console.log(error(`\nFailed to parse Claude output: ${err.message}`));
        console.log(muted('\nRaw output:'));
        console.log(output);
        console.log('');
      }
      return;
    }

    if (parsedTasks.length === 0) {
      console.log(warning('\nNo tasks generated.\n'));
      return;
    }

    console.log(success(`\nGenerated ${String(parsedTasks.length)} task(s):\n`));
    parsedTasks.forEach((task, i) => {
      const deps = task.blockedBy?.length ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
      console.log(`  ${String(i + 1)}. ${task.name}${deps}`);
    });
    console.log('');

    // Validate before import
    const existingTasks = await getTasks(id);
    const validationErrors = validateImportTasks(parsedTasks, existingTasks);
    if (validationErrors.length > 0) {
      console.log(error('Validation failed:'));
      for (const err of validationErrors) {
        console.log(`  - ${err}`);
      }
      console.log('');
      return;
    }

    console.log(info('Importing tasks...'));
    const imported = await importTasks(parsedTasks, id);
    console.log(info(`\nImported ${String(imported)}/${String(parsedTasks.length)} tasks.\n`));
  } else {
    // Interactive mode - user iterates with Claude
    const outputFile = join(tmpdir(), `ralphctl-tasks-${id}.json`);
    const prompt = buildInteractivePrompt(context, outputFile, schema);

    console.log(muted('Starting interactive Claude session...'));
    console.log(muted(`When ready, ask Claude to write tasks to: ${outputFile}\n`));

    try {
      await invokeClaudeInteractive(prompt, primaryPath, additionalPaths);
    } catch (err) {
      if (err instanceof Error) {
        console.log(error(`\nFailed to invoke Claude: ${err.message}`));
        console.log(muted('Make sure the claude CLI is installed and configured.\n'));
      }
      return;
    }

    // Check if output file was created
    console.log('');
    if (await fileExists(outputFile)) {
      console.log(info('Task file found. Processing...'));

      let content: string;
      try {
        content = await readFile(outputFile, 'utf-8');
      } catch {
        console.log(error(`\nFailed to read task file: ${outputFile}\n`));
        return;
      }

      let parsedTasks: ImportTask[];
      try {
        parsedTasks = parseTasksJson(content);
      } catch (err) {
        if (err instanceof Error) {
          console.log(error(`\nFailed to parse task file: ${err.message}\n`));
        }
        return;
      }

      if (parsedTasks.length === 0) {
        console.log(warning('\nNo tasks in file.\n'));
        return;
      }

      console.log(success(`\nFound ${String(parsedTasks.length)} task(s):\n`));
      parsedTasks.forEach((task, i) => {
        const deps = task.blockedBy?.length ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
        console.log(`  ${String(i + 1)}. ${task.name}${deps}`);
      });
      console.log('');

      // Validate before import
      const existingTasks = await getTasks(id);
      const validationErrors = validateImportTasks(parsedTasks, existingTasks);
      if (validationErrors.length > 0) {
        console.log(error('Validation failed:'));
        for (const err of validationErrors) {
          console.log(`  - ${err}`);
        }
        console.log('');
        return;
      }

      console.log(info('Importing tasks...'));
      const imported = await importTasks(parsedTasks, id);
      console.log(info(`\nImported ${String(imported)}/${String(parsedTasks.length)} tasks.\n`));

      // Clean up temp file
      try {
        await unlink(outputFile);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      console.log(warning('No task file found.'));
      console.log(muted(`Expected: ${outputFile}`));
      console.log(muted('Run sprint plan again to create tasks.\n'));
    }
  }
}
