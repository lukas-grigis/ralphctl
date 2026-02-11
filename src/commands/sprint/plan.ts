import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { colors, error, info, muted, success } from '@src/theme/index.ts';
import {
  createSpinner,
  field,
  icons,
  log,
  printHeader,
  renderTable,
  showError,
  showNextStep,
  showWarning,
} from '@src/theme/ui.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { addTask, getTasks, listTasks, saveTasks, validateImportTasks } from '@src/store/task.ts';
import {
  allRequirementsApproved,
  formatTicketDisplay,
  getPendingRequirements,
  groupTicketsByProject,
} from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getPlanningDir, getSchemaPath, getTasksFilePath } from '@src/utils/paths.ts';
import { withFileLock } from '@src/utils/file-lock.ts';
import { buildAutoPrompt, buildInteractivePrompt } from '@src/claude/prompts/index.ts';
import { spawnClaudeHeadless, spawnClaudeInteractive } from '@src/claude/session.ts';
import { ImportTasksSchema, type ImportTask, type Repository, type Ticket } from '@src/schemas/index.ts';
import { selectProjectPaths } from '@src/interactive/selectors.ts';
import { extractJsonArray } from '@src/utils/json-extract.ts';

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

async function invokeClaudeInteractive(prompt: string, repoPaths: string[], planDir: string): Promise<void> {
  // Write full context to the planning directory for reference
  const contextFile = join(planDir, 'planning-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  // Count tickets in the prompt for the summary
  const ticketCount = (prompt.match(/^####/gm) ?? []).length;

  // Build initial prompt that tells Claude to read the context file
  const startPrompt = `I need help planning tasks for a sprint. The full planning context is in planning-context.md (${String(ticketCount)} tickets). Please read that file now and follow the instructions to help me plan implementation tasks.`;

  // Build args - pass all repo paths in a single --add-dir to avoid variadic option
  // consuming the positional prompt argument
  const args: string[] = ['--add-dir', ...repoPaths];

  const result = spawnClaudeInteractive(startPrompt, {
    cwd: planDir,
    args,
    env: {
      // Load CLAUDE.md from --add-dir paths too
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });

  if (result.error) {
    throw new Error(result.error);
  }
}

async function invokeClaudeAuto(prompt: string, repoPaths: string[], planDir: string): Promise<string> {
  // Build args - all repo paths via --add-dir (neutral CWD in planning dir)
  const args: string[] = ['--permission-mode', 'plan', '--print'];
  for (const path of repoPaths) {
    args.push('--add-dir', path);
  }
  args.push('-p', prompt);

  return spawnClaudeHeadless({
    cwd: planDir,
    args,
    env: {
      // Load CLAUDE.md from --add-dir paths too
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    },
  });
}

function parseTasksJson(output: string): ImportTask[] {
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

function renderParsedTasksTable(parsedTasks: ImportTask[]): string {
  const rows = parsedTasks.map((task, i) => {
    const deps = task.blockedBy?.length ? task.blockedBy.join(', ') : '';
    return [String(i + 1), task.name, task.projectPath, deps];
  });
  return renderTable(
    [{ header: '#', align: 'right' as const }, { header: 'Name' }, { header: 'Path' }, { header: 'Blocked By' }],
    rows
  );
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

export async function sprintPlanCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    showWarning('No sprint specified and no current sprint set.');
    showNextStep('ralphctl sprint create', 'create a new sprint');
    log.newline();
    return;
  }

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to plan
  try {
    assertSprintStatus(sprint, ['draft'], 'plan');
  } catch (err) {
    if (err instanceof Error) {
      showError(err.message);
      log.newline();
    }
    return;
  }

  if (sprint.tickets.length === 0) {
    showWarning('No tickets in sprint.');
    showNextStep('ralphctl ticket add --project <project-name>', 'add tickets first');
    log.newline();
    return;
  }

  // Check if all tickets have approved requirements
  if (!allRequirementsApproved(sprint.tickets)) {
    const pendingTickets = getPendingRequirements(sprint.tickets);
    showWarning('Not all tickets have approved requirements.');
    log.dim(`Pending: ${String(pendingTickets.length)} ticket(s)`);
    for (const ticket of pendingTickets) {
      log.item(muted(formatTicketDisplay(ticket)));
    }
    showNextStep('ralphctl sprint refine', 'refine requirements first');
    log.newline();
    return;
  }

  // Group tickets by project
  const ticketsByProject = groupTicketsByProject(sprint.tickets);
  const tasks = await listTasks(id);

  printHeader('Sprint Planning', icons.sprint);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Tickets', String(sprint.tickets.length)));
  console.log(field('Projects', String(ticketsByProject.size)));
  console.log(field('Mode', options.auto ? 'Auto (headless)' : 'Interactive'));

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

  // Collect previously saved affected repos from tickets (for resumability)
  const savedPaths = new Set<string>();
  for (const ticket of sprint.tickets) {
    if (ticket.affectedRepositories) {
      for (const path of ticket.affectedRepositories) {
        savedPaths.add(path);
      }
    }
  }
  const hasSavedSelection = savedPaths.size > 0;

  // Select which paths Claude should explore
  let selectedPaths: string[];
  const totalRepos = [...reposByProject.values()].reduce((n, repos) => n + repos.length, 0);

  if (options.allPaths) {
    // --all-paths: use all (opt-in to current slow behavior)
    selectedPaths = [...reposByProject.values()].flatMap((repos) => repos.map((r) => r.path));
  } else if (options.auto) {
    // --auto: use saved selection or first repo per project
    selectedPaths = hasSavedSelection ? [...savedPaths] : defaultPaths;
  } else if (totalRepos === defaultPaths.length) {
    // Only one repo per project - no selection needed
    selectedPaths = defaultPaths;
  } else {
    // Multiple repos available - show checkbox (pre-select saved paths if any)
    selectedPaths = await selectProjectPaths(
      reposByProject,
      'Select paths for Claude to explore:',
      hasSavedSelection ? [...savedPaths] : undefined
    );
  }

  // Persist selected paths to ticket.affectedRepositories
  for (const ticket of sprint.tickets) {
    const projectRepos = reposByProject.get(ticket.projectName);
    if (projectRepos) {
      const projectRepoPaths = new Set(projectRepos.map((r) => r.path));
      ticket.affectedRepositories = selectedPaths.filter((p) => projectRepoPaths.has(p));
    } else {
      ticket.affectedRepositories = [];
    }
  }
  await saveSprint(sprint);

  if (selectedPaths.length > 1) {
    console.log(muted(`Paths: ${selectedPaths.join(', ')}`));
  } else {
    console.log(muted(`Path: ${selectedPaths[0] ?? process.cwd()}`));
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

  // Create planning directory in the sprint's data folder
  const planDir = getPlanningDir(id);
  await mkdir(planDir, { recursive: true });

  // Build ticket ID set for validating ticketId references during import
  const ticketIds = new Set(sprint.tickets.map((t) => t.id));

  if (options.auto) {
    // Headless mode - Claude generates and we import
    const prompt = buildAutoPrompt(context, schema);
    const spinner = createSpinner('Claude is planning tasks...');
    spinner.start();

    let output: string;
    try {
      output = await invokeClaudeAuto(prompt, selectedPaths, planDir);
      spinner.succeed('Claude finished planning');
    } catch (err) {
      spinner.fail('Claude planning failed');
      if (err instanceof Error) {
        showError(`Failed to invoke Claude: ${err.message}`);
        log.dim('Make sure the claude CLI is installed and configured.');
        log.newline();
      }
      return;
    }

    console.log(muted('Parsing response...'));
    let parsedTasks: ImportTask[];
    try {
      parsedTasks = parseTasksJson(output);
    } catch (err) {
      if (err instanceof Error) {
        showError(`Failed to parse Claude output: ${err.message}`);
        log.dim('Raw output:');
        console.log(output);
        log.newline();
      }
      return;
    }

    if (parsedTasks.length === 0) {
      showWarning('No tasks generated.');
      log.newline();
      return;
    }

    console.log(colors.success(`\nGenerated ${String(parsedTasks.length)} task(s):\n`));
    console.log(renderParsedTasksTable(parsedTasks));
    console.log('');

    // Validate before import
    const existingTasks = await getTasks(id);
    const validationErrors = validateImportTasks(parsedTasks, existingTasks, ticketIds);
    if (validationErrors.length > 0) {
      showError('Validation failed');
      for (const err of validationErrors) {
        log.item(error(err));
      }
      log.newline();
      return;
    }

    console.log(info('Importing tasks...'));
    const imported = await importTasks(parsedTasks, id);
    console.log(info(`\nImported ${String(imported)}/${String(parsedTasks.length)} tasks.\n`));
  } else {
    // Interactive mode - user iterates with Claude
    const outputFile = join(planDir, 'tasks.json');
    const prompt = buildInteractivePrompt(context, outputFile, schema);

    console.log(info('Starting interactive Claude session...\n'));
    console.log(
      muted(`  Planning ${String(sprint.tickets.length)} ticket(s) across ${String(ticketsByProject.size)} project(s)`)
    );
    console.log(muted(`  Exploring: ${selectedPaths.join(', ')}`));
    console.log(muted(`\n  Claude will read planning-context.md and explore the repos.`));
    console.log(muted(`  When done, ask Claude to write tasks to: ${outputFile}\n`));

    try {
      await invokeClaudeInteractive(prompt, selectedPaths, planDir);
    } catch (err) {
      if (err instanceof Error) {
        showError(`Failed to invoke Claude: ${err.message}`);
        log.dim('Make sure the claude CLI is installed and configured.');
        log.newline();
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
        showError(`Failed to read task file: ${outputFile}`);
        log.newline();
        return;
      }

      let parsedTasks: ImportTask[];
      try {
        parsedTasks = parseTasksJson(content);
      } catch (err) {
        if (err instanceof Error) {
          showError(`Failed to parse task file: ${err.message}`);
          log.newline();
        }
        return;
      }

      if (parsedTasks.length === 0) {
        showWarning('No tasks in file.');
        log.newline();
        return;
      }

      console.log(colors.success(`\nFound ${String(parsedTasks.length)} task(s):\n`));
      console.log(renderParsedTasksTable(parsedTasks));
      console.log('');

      // Validate before import
      const existingTasks = await getTasks(id);
      const validationErrors = validateImportTasks(parsedTasks, existingTasks, ticketIds);
      if (validationErrors.length > 0) {
        showError('Validation failed');
        for (const err of validationErrors) {
          log.item(error(err));
        }
        log.newline();
        return;
      }

      console.log(info('Importing tasks...'));
      const imported = await importTasks(parsedTasks, id);
      console.log(info(`\nImported ${String(imported)}/${String(parsedTasks.length)} tasks.\n`));
    } else {
      showWarning('No task file found.');
      log.dim(`Expected: ${outputFile}`);
      showNextStep('ralphctl sprint plan', 'run planning again to create tasks');
      log.newline();
    }
  }
}
