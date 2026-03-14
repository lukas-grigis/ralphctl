import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { input, select } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { wrapAsync } from '@src/utils/result-helpers.ts';
import { editorInput } from '@src/utils/editor-input.ts';
import { error, muted } from '@src/theme/index.ts';
import {
  createSpinner,
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
import { addTicket } from '@src/store/ticket.ts';
import { getTasks, validateImportTasks } from '@src/store/task.ts';
import { getProject, listProjects } from '@src/store/project.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getIdeateDir } from '@src/utils/paths.ts';
import { buildIdeateAutoPrompt, buildIdeatePrompt } from '@src/ai/prompts/index.ts';
import { spawnHeadless, spawnInteractive } from '@src/ai/session.ts';
import { IdeateOutputSchema, type Repository } from '@src/schemas/index.ts';
import { selectProjectPaths } from '@src/interactive/selectors.ts';
import { extractJsonObject } from '@src/utils/json-extract.ts';
import { resolveProvider, providerDisplayName } from '@src/utils/provider.ts';
import { getActiveProvider } from '@src/providers/index.ts';
import {
  getTaskImportSchema,
  importTasks,
  parsePlanningBlocked,
  parseTasksJson,
  renderParsedTasksTable,
} from './plan-utils.ts';

interface IdeateOptions {
  auto: boolean;
  allPaths: boolean;
  project?: string;
}

function parseArgs(args: string[]): { sprintId?: string; options: IdeateOptions } {
  const options: IdeateOptions = {
    auto: false,
    allPaths: false,
  };
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '--all-paths') {
      options.allPaths = true;
    } else if (arg === '--project') {
      options.project = nextArg;
      i++;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

async function invokeAiInteractive(prompt: string, repoPaths: string[], ideateDir: string): Promise<void> {
  // Write full context to the ideation directory for reference
  const contextFile = join(ideateDir, 'ideate-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  const provider = await getActiveProvider();

  // Build initial prompt that tells the AI to start the two-phase process
  const startPrompt = `I have a quick idea I want to implement. The full context is in ideate-context.md. Please read that file and help me refine the idea into requirements and then plan implementation tasks.`;

  // Build args - pass all repo paths in a single --add-dir
  const args: string[] = ['--add-dir', ...repoPaths];

  const result = spawnInteractive(
    startPrompt,
    {
      cwd: ideateDir,
      args,
      env: provider.getSpawnEnv(),
    },
    provider
  );

  if (result.error) {
    throw new Error(result.error);
  }
}

async function invokeAiAuto(prompt: string, repoPaths: string[], ideateDir: string): Promise<string> {
  const provider = await getActiveProvider();

  // Build args - all repo paths via --add-dir (neutral CWD in ideation dir)
  const args: string[] = ['--permission-mode', 'plan', '--print'];
  for (const path of repoPaths) {
    args.push('--add-dir', path);
  }
  args.push('-p', prompt);

  return spawnHeadless(
    {
      cwd: ideateDir,
      args,
      env: provider.getSpawnEnv(),
    },
    provider
  );
}

function parseIdeateOutput(output: string): { requirements: string; tasks: unknown[] } {
  // Try to extract a balanced JSON object from the output
  const jsonStr = extractJsonObject(output);

  const parseR = Result.try(() => JSON.parse(jsonStr) as unknown);
  if (!parseR.ok) {
    throw new Error(`Invalid JSON: ${parseR.error.message}`, { cause: parseR.error });
  }

  // Validate against schema
  const result = IdeateOutputSchema.safeParse(parseR.value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `[${issue.path.join('.')}]` : '';
        return `  ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid ideate output format:\n${issues}`);
  }

  return result.data;
}

export async function sprintIdeateCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(
    () => resolveSprintId(sprintId),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showNextStep('ralphctl sprint create', 'create a new sprint');
    log.newline();
    return;
  }
  const id = idR.value;

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to ideate
  const statusR = Result.try(() => {
    assertSprintStatus(sprint, ['draft'], 'ideate');
  });
  if (!statusR.ok) {
    showError(statusR.error.message);
    log.newline();
    return;
  }

  // Check if projects exist
  const projects = await listProjects();
  if (projects.length === 0) {
    showWarning('No projects configured.');
    showNextStep('ralphctl project add', 'add a project first');
    log.newline();
    return;
  }

  printHeader('Quick Ideation', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Mode', options.auto ? 'Auto (headless)' : 'Interactive'));
  log.newline();

  // Prompt for project if not specified
  let projectName = options.project;
  if (!projectName) {
    if (projects.length === 1) {
      projectName = projects[0]?.name;
      console.log(field('Project', projectName ?? '(unknown)'));
    } else {
      // Interactive project selection
      projectName = await select({
        message: 'Select project:',
        choices: projects.map((p) => ({ name: p.displayName, value: p.name })),
      });
    }
  }

  if (!projectName) {
    showError('No project selected.');
    log.newline();
    return;
  }

  // Validate project exists
  const projectR = await wrapAsync(
    () => getProject(projectName),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!projectR.ok) {
    showError(`Project '${projectName}' not found.`);
    log.newline();
    return;
  }
  const project = projectR.value;

  // Prompt for idea title and description
  const ideaTitle = await input({
    message: 'Idea title (short summary):',
    validate: (value) => (value.trim().length > 0 ? true : 'Title is required'),
  });

  const editorR = await editorInput({
    message: 'Idea description (what you want to build):',
  });
  if (!editorR.ok) {
    showError(`Editor input failed: ${editorR.error.message}`);
    log.newline();
    return;
  }
  const ideaDescription = editorR.value;

  if (!ideaDescription.trim()) {
    showError('Description is required.');
    log.newline();
    return;
  }

  log.newline();
  showInfo('Creating ticket...');

  // Auto-create ticket with pending status
  const ticket = await addTicket(
    {
      title: ideaTitle,
      description: ideaDescription,
      projectName,
    },
    id
  );

  console.log(field('Ticket ID', ticket.id));
  log.newline();

  // Resolve AI provider early for display names
  const providerName = providerDisplayName(await resolveProvider());

  // Select which paths the AI should explore (same as plan.ts)
  let selectedPaths: string[];
  const totalRepos = project.repositories.length;

  if (options.allPaths) {
    // --all-paths: use all repos
    selectedPaths = project.repositories.map((r) => r.path);
  } else if (options.auto) {
    // --auto: use first repo per project
    selectedPaths = project.repositories.slice(0, 1).map((r) => r.path);
  } else if (totalRepos === 1) {
    // Only one repo - no selection needed
    selectedPaths = [project.repositories[0]?.path ?? ''];
  } else {
    // Multiple repos available - show checkbox
    const reposByProject = new Map<string, Repository[]>();
    reposByProject.set(projectName, project.repositories);

    selectedPaths = await selectProjectPaths(reposByProject, 'Select paths to explore:');
  }

  // Save selected paths to ticket.affectedRepositories
  ticket.affectedRepositories = selectedPaths;
  await saveSprint(sprint);

  if (selectedPaths.length > 1) {
    console.log(muted(`Paths: ${selectedPaths.join(', ')}`));
  } else {
    console.log(muted(`Path: ${selectedPaths[0] ?? process.cwd()}`));
  }

  // Format repositories for prompt
  const repositoriesText = selectedPaths.map((path) => `- ${path}`).join('\n');

  // Load schema
  const schema = await getTaskImportSchema();

  // Create ideation directory
  const ideateDir = getIdeateDir(id, ticket.id);
  await mkdir(ideateDir, { recursive: true });

  if (options.auto) {
    // Headless mode - AI generates autonomously
    const prompt = buildIdeateAutoPrompt(ideaTitle, ideaDescription, projectName, repositoriesText, schema);
    const spinner = createSpinner(`${providerName} is refining idea and planning tasks...`);
    spinner.start();

    const outputR = await wrapAsync(
      () => invokeAiAuto(prompt, selectedPaths, ideateDir),
      (err) => (err instanceof Error ? err : new Error(String(err)))
    );
    if (!outputR.ok) {
      spinner.fail(`${providerName} session failed`);
      showError(`Failed to invoke ${providerName}: ${outputR.error.message}`);
      showTip(`Make sure the ${providerName.toLowerCase()} CLI is installed and configured.`);
      log.newline();
      return;
    }
    spinner.succeed(`${providerName} finished`);
    const output = outputR.value;

    // Check for planning-blocked signal before parsing JSON
    const blockedReason = parsePlanningBlocked(output);
    if (blockedReason) {
      showWarning(`Planning blocked: ${blockedReason}`);
      log.newline();
      return;
    }

    log.dim('Parsing response...');
    const ideateR = Result.try(() => parseIdeateOutput(output));
    if (!ideateR.ok) {
      showError(`Failed to parse ${providerName} output: ${ideateR.error.message}`);
      log.dim('Raw output:');
      console.log(output);
      log.newline();
      return;
    }
    const ideateOutput = ideateR.value;

    // Update ticket with requirements
    const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
    const ticketToUpdate = sprint.tickets[ticketIdx];
    if (ticketIdx !== -1 && ticketToUpdate) {
      ticketToUpdate.requirements = ideateOutput.requirements;
      ticketToUpdate.requirementStatus = 'approved';
    }
    await saveSprint(sprint);

    showSuccess('Requirements approved and saved!');
    log.newline();

    // Parse and validate tasks
    const parsedTasksR = Result.try(() => parseTasksJson(JSON.stringify(ideateOutput.tasks)));
    if (!parsedTasksR.ok) {
      showError(`Failed to parse tasks: ${parsedTasksR.error.message}`);
      log.newline();
      return;
    }
    const parsedTasks = parsedTasksR.value;

    if (parsedTasks.length === 0) {
      showWarning('No tasks generated.');
      log.newline();
      return;
    }

    showSuccess(`Generated ${String(parsedTasks.length)} task(s):`);
    log.newline();
    console.log(renderParsedTasksTable(parsedTasks));
    console.log('');

    // Validate before import
    const existingTasks = await getTasks(id);
    const ticketIds = new Set(sprint.tickets.map((t) => t.id));
    const validationErrors = validateImportTasks(parsedTasks, existingTasks, ticketIds);
    if (validationErrors.length > 0) {
      showError('Validation failed');
      for (const err of validationErrors) {
        log.item(error(err));
      }
      log.newline();
      return;
    }

    showInfo('Importing tasks...');
    const imported = await importTasks(parsedTasks, id);
    terminalBell();
    showSuccess(`Imported ${String(imported)}/${String(parsedTasks.length)} tasks.`);
    log.newline();
  } else {
    // Interactive mode - user iterates with AI
    const outputFile = join(ideateDir, 'output.json');
    const prompt = buildIdeatePrompt(ideaTitle, ideaDescription, projectName, repositoriesText, outputFile, schema);

    showInfo(`Starting interactive ${providerName} session...`);
    console.log(muted(`  Exploring: ${selectedPaths.join(', ')}`));
    console.log(muted(`\n  ${providerName} will guide you through requirements refinement and task planning.`));
    console.log(muted(`  When done, ask ${providerName} to write the output to: ${outputFile}\n`));

    const interactiveR = await wrapAsync(
      () => invokeAiInteractive(prompt, selectedPaths, ideateDir),
      (err) => (err instanceof Error ? err : new Error(String(err)))
    );
    if (!interactiveR.ok) {
      showError(`Failed to invoke ${providerName}: ${interactiveR.error.message}`);
      showTip(`Make sure the ${providerName.toLowerCase()} CLI is installed and configured.`);
      log.newline();
      return;
    }

    // Check if output file was created
    console.log('');
    if (await fileExists(outputFile)) {
      showInfo('Output file found. Processing...');

      const contentR = await wrapAsync(
        () => readFile(outputFile, 'utf-8'),
        (err) => (err instanceof Error ? err : new Error(String(err)))
      );
      if (!contentR.ok) {
        showError(`Failed to read output file: ${outputFile}`);
        log.newline();
        return;
      }

      const ideateR = Result.try(() => parseIdeateOutput(contentR.value));
      if (!ideateR.ok) {
        showError(`Failed to parse output file: ${ideateR.error.message}`);
        log.newline();
        return;
      }
      const ideateOutput = ideateR.value;

      // Update ticket with requirements
      const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
      const ticketToUpdate = sprint.tickets[ticketIdx];
      if (ticketIdx !== -1 && ticketToUpdate) {
        ticketToUpdate.requirements = ideateOutput.requirements;
        ticketToUpdate.requirementStatus = 'approved';
      }
      await saveSprint(sprint);

      showSuccess('Requirements approved and saved!');
      log.newline();

      // Parse and validate tasks
      const parsedTasksR = Result.try(() => parseTasksJson(JSON.stringify(ideateOutput.tasks)));
      if (!parsedTasksR.ok) {
        showError(`Failed to parse tasks: ${parsedTasksR.error.message}`);
        log.newline();
        return;
      }
      const parsedTasks = parsedTasksR.value;

      if (parsedTasks.length === 0) {
        showWarning('No tasks in file.');
        log.newline();
        return;
      }

      showSuccess(`Found ${String(parsedTasks.length)} task(s):`);
      log.newline();
      console.log(renderParsedTasksTable(parsedTasks));
      console.log('');

      // Validate before import
      const existingTasks = await getTasks(id);
      const ticketIds = new Set(sprint.tickets.map((t) => t.id));
      const validationErrors = validateImportTasks(parsedTasks, existingTasks, ticketIds);
      if (validationErrors.length > 0) {
        showError('Validation failed');
        for (const err of validationErrors) {
          log.item(error(err));
        }
        log.newline();
        return;
      }

      showInfo('Importing tasks...');
      const imported = await importTasks(parsedTasks, id);
      terminalBell();
      showSuccess(`Imported ${String(imported)}/${String(parsedTasks.length)} tasks.`);
      log.newline();
    } else {
      showWarning('No output file found.');
      showTip(`Expected: ${outputFile}`);
      showNextStep('ralphctl sprint ideate', 'run ideation again');
      log.newline();
    }
  }
}
