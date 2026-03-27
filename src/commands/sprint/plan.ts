import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { error, muted } from '@src/theme/index.ts';
import {
  createSpinner,
  emoji,
  field,
  icons,
  log,
  printHeader,
  showError,
  showInfo,
  showNextStep,
  showSuccess,
  showTip,
  showWarning,
  terminalBell,
} from '@src/theme/ui.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { getTasks, listTasks, reorderByDependencies, validateImportTasks } from '@src/store/task.ts';
import {
  allRequirementsApproved,
  formatTicketDisplay,
  getPendingRequirements,
  groupTicketsByProject,
} from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getPlanningDir } from '@src/utils/paths.ts';
import { buildAutoPrompt, buildInteractivePrompt } from '@src/ai/prompts/index.ts';
import { spawnHeadless, spawnInteractive } from '@src/ai/session.ts';
import { type ImportTask, type Repository, type Ticket } from '@src/schemas/index.ts';
import { selectProjectPaths } from '@src/interactive/selectors.ts';
import { providerDisplayName, resolveProvider } from '@src/utils/provider.ts';
import { getActiveProvider } from '@src/providers/index.ts';
import {
  buildHeadlessAiRequest,
  getTaskImportSchema,
  importTasks,
  parsePlanningBlocked,
  parseTasksJson,
  renderParsedTasksTable,
} from './plan-utils.ts';

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
  existingTasks: {
    id: string;
    name: string;
    description?: string;
    status: string;
    ticketId?: string;
    projectPath: string;
  }[]
): Promise<string> {
  const lines: string[] = [];
  lines.push(`# Sprint: ${sprintName}`);

  // Group tickets by project in context
  for (const [projectName, tickets] of ticketsByProject) {
    lines.push('');
    lines.push(`## Project: ${projectName}`);

    // Get project repositories
    const projectR = await wrapAsync(() => getProject(projectName), ensureError);
    if (projectR.ok) {
      lines.push('');
      lines.push('### Repositories');
      for (const repo of projectR.value.repositories) {
        lines.push(`- **${repo.name}**: ${repo.path}`);
        if (repo.checkScript) {
          lines.push(`  - Check: \`${repo.checkScript}\``);
        }
      }
    } else {
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
    lines.push(
      '> These are tasks from a previous planning run. Your output will replace all existing tasks entirely. You may reuse, modify, or drop existing tasks, and add new ones. Generate a complete task set covering ALL tickets.'
    );
    lines.push('');
    for (const task of existingTasks) {
      const desc = task.description ? ` — ${task.description}` : '';
      const ticket = task.ticketId ? ` ticket:${task.ticketId}` : '';
      lines.push(`- ${task.id}: ${task.name} [${task.status}] (${task.projectPath})${ticket}${desc}`);
    }
  }

  return lines.join('\n');
}

async function invokeAiInteractive(prompt: string, repoPaths: string[], planDir: string): Promise<void> {
  // Write full context to the planning directory for reference
  const contextFile = join(planDir, 'planning-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  const provider = await getActiveProvider();

  // Count tickets in the prompt for the summary
  const ticketCount = (prompt.match(/^####/gm) ?? []).length;

  // Build initial prompt that tells the AI to read the context file
  const startPrompt = `I need help planning tasks for a sprint. The full planning context is in planning-context.md (${String(ticketCount)} tickets). Please read that file now and follow the instructions to help me plan implementation tasks.`;

  // One --add-dir per path (Copilot requires repeated flags; Claude also accepts this form)
  const args: string[] = repoPaths.flatMap((path) => ['--add-dir', path]);

  const result = spawnInteractive(
    startPrompt,
    {
      cwd: planDir,
      args,
      env: provider.getSpawnEnv(),
    },
    provider
  );

  if (result.error) {
    throw new Error(result.error);
  }
}

async function invokeAiAuto(prompt: string, repoPaths: string[], planDir: string): Promise<string> {
  const provider = await getActiveProvider();
  const request = buildHeadlessAiRequest(repoPaths, prompt);

  return spawnHeadless(
    {
      cwd: planDir,
      args: request.args,
      prompt: request.prompt,
      env: provider.getSpawnEnv(),
    },
    provider
  );
}

export async function sprintPlanCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showNextStep('ralphctl sprint create', 'create a new sprint');
    log.newline();
    return;
  }
  const id = idR.value;

  const sprint = await getSprint(id);

  // Check sprint status — draft only
  try {
    assertSprintStatus(sprint, ['draft'], 'plan');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    log.newline();
    return;
  }

  if (sprint.tickets.length === 0) {
    showWarning('No tickets in sprint.');
    showNextStep('ralphctl ticket add --project <project-name>', 'add tickets first');
    log.newline();
    return;
  }

  // Always process ALL tickets
  const ticketsToProcess = sprint.tickets;

  // Check if all tickets have approved requirements
  if (!allRequirementsApproved(ticketsToProcess)) {
    const pendingTickets = getPendingRequirements(ticketsToProcess);
    showWarning('Not all tickets have approved requirements.');
    log.dim(`Pending: ${String(pendingTickets.length)} ticket(s)`);
    for (const ticket of pendingTickets) {
      log.item(muted(formatTicketDisplay(ticket)));
    }
    showNextStep('ralphctl sprint refine', 'refine requirements first');
    log.newline();
    return;
  }

  // Check for existing tasks (re-plan scenario)
  const existingTasks = await listTasks(id);
  const isReplan = existingTasks.length > 0;

  if (isReplan) {
    if (options.auto) {
      showInfo(`Re-plan: ${String(existingTasks.length)} existing task(s) will be replaced with a fresh plan.`);
      log.newline();
    } else {
      const proceed = await confirm({
        message: `${emoji.donut} ${String(existingTasks.length)} task(s) already exist. Re-planning will replace all tasks. Continue?`,
        default: true,
      });

      if (!proceed) {
        log.dim('Cancelled.');
        log.newline();
        return;
      }
    }
  }

  // Group tickets to process by project
  const ticketsByProject = groupTicketsByProject(ticketsToProcess);

  // Resolve AI provider early for display names
  const providerName = providerDisplayName(await resolveProvider());

  // Determine mode label
  const modeLabel = options.auto ? 'Auto (headless)' : 'Interactive';

  printHeader('Sprint Planning', icons.sprint);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Tickets', String(ticketsToProcess.length)));
  console.log(field('Projects', String(ticketsByProject.size)));
  console.log(field('Mode', modeLabel));
  console.log(field('Provider', providerName));

  for (const [proj, tickets] of ticketsByProject) {
    console.log(muted(`  - ${proj}: ${String(tickets.length)} ticket(s)`));
  }
  console.log('');

  // Collect repositories by project for selection UI (from tickets being planned)
  const reposByProject = new Map<string, Repository[]>();
  const defaultPaths: string[] = []; // First repo path per project

  for (const ticket of ticketsToProcess) {
    if (reposByProject.has(ticket.projectName)) continue; // Already processed
    const projectR = await wrapAsync(() => getProject(ticket.projectName), ensureError);
    if (projectR.ok) {
      reposByProject.set(ticket.projectName, projectR.value.repositories);
      if (projectR.value.repositories[0]) defaultPaths.push(projectR.value.repositories[0].path);
    }
    // Project not found — skip silently
  }

  // Collect previously saved affected repos from tickets being planned (for resumability)
  const savedPaths = new Set<string>();
  for (const ticket of ticketsToProcess) {
    if (ticket.affectedRepositories) {
      for (const path of ticket.affectedRepositories) {
        savedPaths.add(path);
      }
    }
  }
  const hasSavedSelection = savedPaths.size > 0;

  // Select which paths the AI should explore
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
      'Select paths to explore:',
      hasSavedSelection ? [...savedPaths] : undefined
    );
  }

  // Persist selected paths to ticket.affectedRepositories (only for planned tickets)
  for (const ticket of ticketsToProcess) {
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
    existingTasks.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      status: t.status,
      ticketId: t.ticketId,
      projectPath: t.projectPath,
    }))
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
    // Headless mode - AI generates and we import
    const prompt = buildAutoPrompt(context, schema);
    const spinner = createSpinner(`${providerName} is planning tasks...`);
    spinner.start();

    const outputR = await wrapAsync(() => invokeAiAuto(prompt, selectedPaths, planDir), ensureError);
    if (!outputR.ok) {
      spinner.fail(`${providerName} planning failed`);
      showError(`Failed to invoke ${providerName}: ${outputR.error.message}`);
      showTip(`Make sure the ${providerName.toLowerCase()} CLI is installed and configured.`);
      log.newline();
      return;
    }
    spinner.succeed(`${providerName} finished planning`);
    const output = outputR.value;

    // Check for planning-blocked signal before parsing JSON
    const blockedReason = parsePlanningBlocked(output);
    if (blockedReason) {
      showWarning(`Planning blocked: ${blockedReason}`);
      log.newline();
      return;
    }

    console.log(muted('Parsing response...'));
    const parsedR = Result.try(() => parseTasksJson(output));
    if (!parsedR.ok) {
      showError(`Failed to parse ${providerName} output: ${parsedR.error.message}`);
      log.dim('Raw output:');
      console.log(output);
      log.newline();
      return;
    }
    const parsedTasks: ImportTask[] = parsedR.value;

    if (parsedTasks.length === 0) {
      showWarning('No tasks generated.');
      log.newline();
      return;
    }

    showSuccess(`Generated ${String(parsedTasks.length)} task(s):`);
    log.newline();
    console.log(renderParsedTasksTable(parsedTasks));
    console.log('');

    // Validate before import — when replacing, pass empty existingTasks since new set is self-contained
    const validationExistingTasks = isReplan ? [] : await getTasks(id);
    const validationErrors = validateImportTasks(parsedTasks, validationExistingTasks, ticketIds);
    if (validationErrors.length > 0) {
      showError('Validation failed');
      for (const err of validationErrors) {
        log.item(error(err));
      }
      log.newline();
      return;
    }

    showInfo('Importing tasks...');
    const imported = await importTasks(parsedTasks, id, isReplan ? { replace: true } : undefined);

    await reorderByDependencies(id);
    log.dim('Tasks reordered by dependencies.');

    terminalBell();
    showSuccess(`Imported ${String(imported)}/${String(parsedTasks.length)} tasks.`);
    log.newline();
  } else {
    // Interactive mode - user iterates with AI
    const outputFile = join(planDir, 'tasks.json');
    const prompt = buildInteractivePrompt(context, outputFile, schema);

    showInfo(`Starting interactive ${providerName} session...`);
    console.log(
      muted(
        `  Planning ${String(ticketsToProcess.length)} ticket(s) across ${String(ticketsByProject.size)} project(s)`
      )
    );
    console.log(muted(`  Exploring: ${selectedPaths.join(', ')}`));
    console.log(muted(`\n  ${providerName} will read planning-context.md and explore the repos.`));
    console.log(muted(`  When done, ask ${providerName} to write tasks to: ${outputFile}\n`));

    const interactiveR = await wrapAsync(() => invokeAiInteractive(prompt, selectedPaths, planDir), ensureError);
    if (!interactiveR.ok) {
      showError(`Failed to invoke ${providerName}: ${interactiveR.error.message}`);
      showTip(`Make sure the ${providerName.toLowerCase()} CLI is installed and configured.`);
      log.newline();
      return;
    }

    // Check if output file was created
    console.log('');
    if (await fileExists(outputFile)) {
      showInfo('Task file found. Processing...');

      const contentR = await wrapAsync(() => readFile(outputFile, 'utf-8'), ensureError);
      if (!contentR.ok) {
        showError(`Failed to read task file: ${outputFile}`);
        log.newline();
        return;
      }

      const parsedR = Result.try(() => parseTasksJson(contentR.value));
      if (!parsedR.ok) {
        showError(`Failed to parse task file: ${parsedR.error.message}`);
        log.newline();
        return;
      }
      const parsedTasks: ImportTask[] = parsedR.value;

      if (parsedTasks.length === 0) {
        showWarning('No tasks in file.');
        log.newline();
        return;
      }

      showSuccess(`Found ${String(parsedTasks.length)} task(s):`);
      log.newline();
      console.log(renderParsedTasksTable(parsedTasks));
      console.log('');

      // Validate before import — when replacing, pass empty existingTasks since new set is self-contained
      const validationExistingTasks = isReplan ? [] : await getTasks(id);
      const validationErrors = validateImportTasks(parsedTasks, validationExistingTasks, ticketIds);
      if (validationErrors.length > 0) {
        showError('Validation failed');
        for (const err of validationErrors) {
          log.item(error(err));
        }
        log.newline();
        return;
      }

      showInfo('Importing tasks...');
      const imported = await importTasks(parsedTasks, id, isReplan ? { replace: true } : undefined);

      await reorderByDependencies(id);
      log.dim('Tasks reordered by dependencies.');

      terminalBell();
      showSuccess(`Imported ${String(imported)}/${String(parsedTasks.length)} tasks.`);
      log.newline();
    } else {
      showWarning('No task file found.');
      showTip(`Expected: ${outputFile}`);
      showNextStep('ralphctl sprint plan', 'run planning again to create tasks');
      log.newline();
    }
  }
}
