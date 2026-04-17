import {
  getTaskImportJsonSchema,
  type ImportTask,
  type Project,
  type Repository,
  type Task,
  type Ticket,
} from '@src/domain/models.ts';
import { DomainError, ParseError, ProjectNotFoundError, SprintStatusError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { IdeateOptions, PlanOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PlanSummary {
  importedCount: number;
  totalGenerated: number;
  isReplan: boolean;
}

export interface IdeationSummary {
  ticketId: string;
  requirements: string;
  importedTasks: number;
}

// ---------------------------------------------------------------------------
// PlanSprintTasksUseCase
// ---------------------------------------------------------------------------

export class PlanSprintTasksUseCase {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly aiSession: AiSessionPort,
    private readonly promptBuilder: PromptBuilderPort,
    private readonly parser: OutputParserPort,
    private readonly ui: UserInteractionPort,
    private readonly logger: LoggerPort,
    private readonly external: ExternalPort,
    private readonly fs: FilesystemPort
  ) {}

  async execute(sprintId: string, options?: PlanOptions): Promise<Result<PlanSummary, DomainError>> {
    const log = this.logger.child({ sprintId });

    try {
      // Resolve provider once so the sync getters are safe below.
      await this.aiSession.ensureReady();

      // 1. Get sprint, assert draft status
      const sprint = await this.persistence.getSprint(sprintId);

      if (sprint.status !== 'draft') {
        return Result.error(
          new SprintStatusError(`Sprint must be draft to plan (current: ${sprint.status})`, sprint.status, 'plan')
        );
      }

      if (sprint.tickets.length === 0) {
        return Result.error(new ParseError('No tickets in sprint.'));
      }

      // 2. Check all requirements approved
      const ticketsToProcess = sprint.tickets;
      const allApproved =
        ticketsToProcess.length > 0 && ticketsToProcess.every((t) => t.requirementStatus === 'approved');

      if (!allApproved) {
        return Result.error(new ParseError('Not all tickets have approved requirements. Run sprint refine first.'));
      }

      // 3. Check for existing tasks (re-plan scenario)
      const existingTasks = await this.persistence.getTasks(sprintId);
      const isReplan = existingTasks.length > 0;

      // 4. Confirm re-plan if tasks exist
      if (isReplan && !options?.auto) {
        const proceed = await this.ui.confirm(
          `${String(existingTasks.length)} task(s) already exist. Re-planning will replace all tasks. Continue?`,
          true
        );
        if (!proceed) {
          return Result.ok({ importedCount: 0, totalGenerated: 0, isReplan });
        }
      }

      // 5. Get repositories from the sprint's project (every sprint is scoped
      // to exactly one project post repoId migration).
      let project: Project;
      try {
        project = await this.persistence.getProjectById(sprint.projectId);
      } catch {
        return Result.error(new ProjectNotFoundError(sprint.projectId));
      }

      const reposById = new Map(project.repositories.map((r) => [r.id, r] as const));
      const reposByPath = new Map(project.repositories.map((r) => [r.path, r] as const));
      const reposByProject = new Map<string, Repository[]>();
      reposByProject.set(project.name, project.repositories);
      const firstRepo = project.repositories[0];
      const defaultPaths: string[] = firstRepo ? [firstRepo.path] : [];

      // 6. Select paths
      const savedPaths = collectSavedPaths(ticketsToProcess, reposById);
      const hasSavedSelection = savedPaths.size > 0;
      const totalRepos = project.repositories.length;

      let selectedPaths: string[];
      if (options?.allPaths) {
        selectedPaths = project.repositories.map((r) => r.path);
      } else if (options?.auto) {
        selectedPaths = hasSavedSelection ? [...savedPaths] : defaultPaths;
      } else if (totalRepos === defaultPaths.length) {
        selectedPaths = defaultPaths;
      } else {
        selectedPaths = await this.ui.selectPaths(
          reposByProject,
          'Select paths to explore:',
          hasSavedSelection ? [...savedPaths] : undefined
        );
      }

      // 7. Persist selected repos to tickets as `affectedRepoIds`
      const selectedRepoIds = selectedPaths.map((p) => reposByPath.get(p)?.id).filter((id): id is string => !!id);
      for (const ticket of ticketsToProcess) {
        ticket.affectedRepoIds = selectedRepoIds;
      }
      await this.persistence.saveSprint(sprint);

      // 8. Build sprint context
      const context = await this.buildSprintContext(sprint.name, project, ticketsToProcess, existingTasks, reposById);
      const schema = getTaskImportJsonSchema();
      const projectToolingSection = this.external.detectProjectTooling(selectedPaths);

      // 9. Create planning directory
      const planDir = this.fs.getPlanningDir(sprintId);
      await this.fs.ensureDir(planDir);

      const ticketIds = new Set(sprint.tickets.map((t) => t.id));

      // 10. Run AI session
      let parsedTasks: ImportTask[];

      const stopSession = log.time('ai-plan-session');
      if (options?.auto) {
        parsedTasks = await this.runAutoMode(context, schema, projectToolingSection, selectedPaths, planDir);
      } else {
        parsedTasks = await this.runInteractiveMode(context, schema, projectToolingSection, selectedPaths, planDir);
      }
      stopSession();

      if (parsedTasks.length === 0) {
        return Result.error(new ParseError('No tasks generated.'));
      }

      // 11. Validate and import tasks
      const validationExistingTasks = isReplan ? [] : await this.persistence.getTasks(sprintId);
      const validationErrors = this.persistence.validateImportTasks(parsedTasks, validationExistingTasks, ticketIds);

      if (validationErrors.length > 0) {
        return Result.error(new ParseError(`Task validation failed:\n${validationErrors.join('\n')}`));
      }

      const imported = await this.persistence.importTasks(
        parsedTasks,
        sprintId,
        isReplan ? { replace: true } : undefined
      );

      // 12. Reorder by dependencies
      await this.persistence.reorderByDependencies(sprintId);

      return Result.ok({
        importedCount: imported,
        totalGenerated: parsedTasks.length,
        isReplan,
      });
    } catch (err) {
      return Result.error(
        err instanceof DomainError ? err : new ParseError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  private async runAutoMode(
    context: string,
    schema: string,
    projectToolingSection: string,
    selectedPaths: string[],
    planDir: string
  ): Promise<ImportTask[]> {
    const prompt = this.promptBuilder.buildPlanAutoPrompt(context, schema, projectToolingSection);

    const spinner = this.logger.spinner(`${this.aiSession.getProviderDisplayName()} is planning tasks...`);

    try {
      const args = selectedPaths.flatMap((path) => ['--add-dir', path]);
      const result = await this.aiSession.spawnHeadless(prompt, { cwd: planDir, args });
      spinner.succeed(`${this.aiSession.getProviderDisplayName()} finished planning`);

      // Check for planning-blocked signal
      const blockedReason = this.parser.parsePlanningBlocked(result.output);
      if (blockedReason) {
        this.logger.warning(`Planning blocked: ${blockedReason}`);
        return [];
      }

      return this.parser.parseTasks(result.output);
    } catch (err) {
      spinner.fail(`${this.aiSession.getProviderDisplayName()} planning failed`);
      throw err;
    }
  }

  private async runInteractiveMode(
    context: string,
    schema: string,
    projectToolingSection: string,
    selectedPaths: string[],
    planDir: string
  ): Promise<ImportTask[]> {
    const outputFile = `${planDir}/tasks.json`;
    const prompt = this.promptBuilder.buildPlanInteractivePrompt(context, outputFile, schema, projectToolingSection);

    // Write context file for reference
    await this.fs.writeFile(`${planDir}/planning-context.md`, prompt);

    const args = selectedPaths.flatMap((path) => ['--add-dir', path]);
    await this.aiSession.spawnInteractive(
      `I need help planning tasks for a sprint. The full planning context is in planning-context.md. Please read that file now and follow the instructions to help me plan implementation tasks.`,
      { cwd: planDir, args }
    );

    // Check if output file was created
    const exists = await this.fs.fileExists(outputFile);
    if (!exists) {
      this.logger.warning('No task file found after session.');
      return [];
    }

    const content = await this.fs.readFile(outputFile);
    return this.parser.parseTasks(content);
  }

  private async buildSprintContext(
    sprintName: string,
    project: Project,
    tickets: Ticket[],
    existingTasks: Task[],
    reposById: Map<string, Repository>
  ): Promise<string> {
    const lines: string[] = [];
    lines.push(`# Sprint: ${sprintName}`);
    await Promise.resolve(); // keep method async — call sites await

    lines.push('');
    lines.push(`## Project: ${project.name}`);
    lines.push('');
    lines.push('### Repositories');
    for (const repo of project.repositories) {
      lines.push(`- **${repo.name}** (id=\`${repo.id}\`): ${repo.path}`);
      if (repo.checkScript) {
        lines.push(`  - Check: \`${repo.checkScript}\``);
      }
    }

    lines.push('');
    lines.push('### Tickets');

    for (const ticket of tickets) {
      lines.push('');
      lines.push(`#### [${ticket.id}] ${ticket.title}`);

      if (ticket.description) {
        lines.push('');
        lines.push('**Original Description:**');
        lines.push(ticket.description);
      }
      if (ticket.link) {
        lines.push('');
        lines.push(`Link: ${ticket.link}`);
      }
      if (ticket.requirements) {
        lines.push('');
        lines.push('**Refined Requirements:**');
        lines.push('');
        lines.push(ticket.requirements);
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
        const repoPath = reposById.get(task.repoId)?.path ?? task.repoId;
        lines.push(`- ${task.id}: ${task.name} [${task.status}] (${repoPath})${ticket}${desc}`);
      }
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// IdeateAndPlanUseCase
// ---------------------------------------------------------------------------

export class IdeateAndPlanUseCase {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly aiSession: AiSessionPort,
    private readonly promptBuilder: PromptBuilderPort,
    private readonly parser: OutputParserPort,
    private readonly ui: UserInteractionPort,
    private readonly logger: LoggerPort,
    private readonly external: ExternalPort,
    private readonly fs: FilesystemPort
  ) {}

  async execute(
    sprintId: string,
    idea: { title: string; description: string },
    options?: IdeateOptions
  ): Promise<Result<IdeationSummary, DomainError>> {
    const log = this.logger.child({ sprintId });

    try {
      // Resolve provider once so the sync getters are safe below.
      await this.aiSession.ensureReady();

      // 1. Get sprint, assert draft status
      const sprint = await this.persistence.getSprint(sprintId);

      if (sprint.status !== 'draft') {
        return Result.error(
          new SprintStatusError(`Sprint must be draft to ideate (current: ${sprint.status})`, sprint.status, 'ideate')
        );
      }

      // 2. Resolve project — every sprint is scoped to exactly one project
      // via `sprint.projectId`. Legacy `options.project` is still accepted,
      // but only as a cross-check: if it doesn't match the sprint's project
      // we bail early.
      let project;
      try {
        project = await this.persistence.getProjectById(sprint.projectId);
      } catch {
        return Result.error(new ProjectNotFoundError(sprint.projectId));
      }
      if (options?.project && options.project !== project.name) {
        return Result.error(
          new ParseError(`Sprint belongs to project '${project.name}'; --project '${options.project}' does not match.`)
        );
      }
      const projectName = project.name;

      // 3. Create ticket
      const ticketId = generateTicketId();
      const ticket: Ticket = {
        id: ticketId,
        title: idea.title,
        description: idea.description,
        requirementStatus: 'pending',
      };
      sprint.tickets.push(ticket);
      await this.persistence.saveSprint(sprint);

      this.logger.success(`Ticket created: ${ticketId}`);

      // 4. Select paths
      let selectedPaths: string[];
      if (options?.allPaths) {
        selectedPaths = project.repositories.map((r) => r.path);
      } else if (options?.auto) {
        selectedPaths = project.repositories.slice(0, 1).map((r) => r.path);
      } else if (project.repositories.length === 1) {
        selectedPaths = [project.repositories[0]?.path ?? ''];
      } else {
        const reposByProject = new Map<string, Repository[]>();
        reposByProject.set(projectName, project.repositories);
        selectedPaths = await this.ui.selectPaths(reposByProject, 'Select paths to explore:');
      }

      // Save affected repo ids
      const reposByPath = new Map(project.repositories.map((r) => [r.path, r] as const));
      const selectedRepoIds = selectedPaths.map((p) => reposByPath.get(p)?.id).filter((id): id is string => !!id);
      const updatedSprint = await this.persistence.getSprint(sprintId);
      const savedTicket = updatedSprint.tickets.find((t) => t.id === ticketId);
      if (savedTicket) {
        savedTicket.affectedRepoIds = selectedRepoIds;
      }
      await this.persistence.saveSprint(updatedSprint);

      // 5. Load schema and build context
      const schema = getTaskImportJsonSchema();
      const repositoriesText = selectedPaths.map((path) => `- ${path}`).join('\n');
      const projectToolingSection = this.external.detectProjectTooling(selectedPaths);

      // Build ideation context string
      const context = [
        `# Idea: ${idea.title}`,
        '',
        idea.description,
        '',
        `## Project: ${projectName}`,
        '',
        '### Repositories',
        repositoriesText,
      ].join('\n');

      // Create ideation directory
      const sprintDir = this.fs.getSprintDir(sprintId);
      const ideateDir = `${sprintDir}/ideation/${ticketId}`;
      await this.fs.ensureDir(ideateDir);

      // 6. Run AI session
      let requirements: string;
      let parsedTasks: ImportTask[];

      const stopSession = log.time('ai-ideate-session');
      if (options?.auto) {
        const result = await this.runAutoIdeation(context, schema, projectToolingSection, selectedPaths, ideateDir);
        requirements = result.requirements;
        parsedTasks = result.tasks;
      } else {
        const result = await this.runInteractiveIdeation(
          context,
          schema,
          projectToolingSection,
          selectedPaths,
          ideateDir
        );
        requirements = result.requirements;
        parsedTasks = result.tasks;
      }
      stopSession();

      // 7. Update ticket with requirements
      const finalSprint = await this.persistence.getSprint(sprintId);
      const finalTicket = finalSprint.tickets.find((t) => t.id === ticketId);
      if (finalTicket) {
        finalTicket.requirements = requirements;
        finalTicket.requirementStatus = 'approved';
      }
      await this.persistence.saveSprint(finalSprint);

      if (requirements === '') {
        this.logger.warning('AI output was a bare tasks array — requirements not captured.');
      }

      // 8. Auto-assign ticketId to tasks
      for (const task of parsedTasks) {
        task.ticketId ??= ticketId;
      }

      if (parsedTasks.length === 0) {
        return Result.error(new ParseError('No tasks generated.'));
      }

      // 9. Validate and import tasks
      const existingTasks = await this.persistence.getTasks(sprintId);
      const ticketIds = new Set(finalSprint.tickets.map((t) => t.id));
      const validationErrors = this.persistence.validateImportTasks(parsedTasks, existingTasks, ticketIds);

      if (validationErrors.length > 0) {
        return Result.error(new ParseError(`Task validation failed:\n${validationErrors.join('\n')}`));
      }

      const imported = await this.persistence.importTasks(parsedTasks, sprintId);

      // 10. Reorder by dependencies
      await this.persistence.reorderByDependencies(sprintId);

      return Result.ok({
        ticketId,
        requirements,
        importedTasks: imported,
      });
    } catch (err) {
      return Result.error(
        err instanceof DomainError ? err : new ParseError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  private async runAutoIdeation(
    context: string,
    schema: string,
    projectToolingSection: string,
    selectedPaths: string[],
    ideateDir: string
  ): Promise<{ requirements: string; tasks: ImportTask[] }> {
    const prompt = this.promptBuilder.buildIdeateAutoPrompt(context, schema, projectToolingSection);

    const spinner = this.logger.spinner(
      `${this.aiSession.getProviderDisplayName()} is refining idea and planning tasks...`
    );

    try {
      const args = selectedPaths.flatMap((path) => ['--add-dir', path]);
      const result = await this.aiSession.spawnHeadless(prompt, { cwd: ideateDir, args });
      spinner.succeed(`${this.aiSession.getProviderDisplayName()} finished`);

      // Check for planning-blocked signal
      const blockedReason = this.parser.parsePlanningBlocked(result.output);
      if (blockedReason) {
        this.logger.warning(`Planning blocked: ${blockedReason}`);
        return { requirements: '', tasks: [] };
      }

      const ideation = this.parser.parseIdeation(result.output);
      const tasks = this.parser.parseTasks(JSON.stringify(ideation.tasks));
      return { requirements: ideation.requirements, tasks };
    } catch (err) {
      spinner.fail(`${this.aiSession.getProviderDisplayName()} session failed`);
      throw err;
    }
  }

  private async runInteractiveIdeation(
    context: string,
    schema: string,
    projectToolingSection: string,
    selectedPaths: string[],
    ideateDir: string
  ): Promise<{ requirements: string; tasks: ImportTask[] }> {
    const outputFile = `${ideateDir}/output.json`;
    const prompt = this.promptBuilder.buildIdeateInteractivePrompt(context, outputFile, schema, projectToolingSection);

    // Write context file for reference
    await this.fs.writeFile(`${ideateDir}/ideate-context.md`, prompt);

    const args = selectedPaths.flatMap((path) => ['--add-dir', path]);
    await this.aiSession.spawnInteractive(
      `I have a quick idea I want to implement. The full context is in ideate-context.md. Please read that file and help me refine the idea into requirements and then plan implementation tasks.`,
      { cwd: ideateDir, args }
    );

    // Check if output file was created
    const exists = await this.fs.fileExists(outputFile);
    if (!exists) {
      this.logger.warning('No output file found after session.');
      return { requirements: '', tasks: [] };
    }

    const content = await this.fs.readFile(outputFile);
    const ideation = this.parser.parseIdeation(content);
    const tasks = this.parser.parseTasks(JSON.stringify(ideation.tasks));
    return { requirements: ideation.requirements, tasks };
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure functions, no infrastructure imports)
// ---------------------------------------------------------------------------

function collectSavedPaths(tickets: Ticket[], reposById: Map<string, Repository>): Set<string> {
  const paths = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.affectedRepoIds) {
      for (const repoId of ticket.affectedRepoIds) {
        const repo = reposById.get(repoId);
        if (repo) paths.add(repo.path);
      }
    }
  }
  return paths;
}

/** Generate a simple 8-character hex ID for tickets */
function generateTicketId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
