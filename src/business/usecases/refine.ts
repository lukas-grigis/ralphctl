import type { Ticket, Sprint, RefinedRequirement } from '@src/domain/models.ts';
import { DomainError, SprintStatusError, ParseError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { RefineOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';

export interface RefineSummary {
  approved: number;
  skipped: number;
  total: number;
  allApproved: boolean;
}

export class RefineTicketRequirementsUseCase {
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

  async execute(sprintId: string, options?: RefineOptions): Promise<Result<RefineSummary, DomainError>> {
    try {
      // 1. Get sprint and assert draft status
      const sprint = await this.persistence.getSprint(sprintId);

      if (sprint.status !== 'draft') {
        return Result.error(
          new SprintStatusError(`Sprint must be draft to refine (current: ${sprint.status})`, sprint.status, 'refine')
        );
      }

      if (sprint.tickets.length === 0) {
        return Result.ok({ approved: 0, skipped: 0, total: 0, allApproved: false });
      }

      // 2. Get pending tickets, optionally filtered by project
      let pendingTickets = sprint.tickets.filter((t) => t.requirementStatus === 'pending');

      if (options?.project) {
        pendingTickets = pendingTickets.filter((t) => t.projectName === options.project);
      }

      if (pendingTickets.length === 0) {
        const allApproved = sprint.tickets.every((t) => t.requirementStatus === 'approved');
        return Result.ok({ approved: 0, skipped: 0, total: 0, allApproved });
      }

      // Load schema once
      const schemaPath = this.fs.getSchemaPath('requirements-output.schema.json');
      const schema = await this.fs.readFile(schemaPath);

      let approved = 0;
      let skipped = 0;

      // 3. Process each pending ticket
      for (const ticket of pendingTickets) {
        const result = await this.processTicket(sprint, ticket, schema, options);
        if (result === 'approved') {
          approved++;
        } else {
          skipped++;
        }
      }

      // 4. If all approved, export requirements markdown
      const updatedSprint = await this.persistence.getSprint(sprintId);
      const remainingPending = updatedSprint.tickets.filter((t) => t.requirementStatus === 'pending');
      const allApproved = remainingPending.length === 0;

      if (allApproved) {
        await this.exportRequirements(updatedSprint);
      }

      return Result.ok({
        approved,
        skipped,
        total: pendingTickets.length,
        allApproved,
      });
    } catch (err) {
      return Result.error(
        err instanceof DomainError ? err : new ParseError(err instanceof Error ? err.message : String(err))
      );
    }
  }

  private async processTicket(
    sprint: Sprint,
    ticket: Ticket,
    schema: string,
    options?: RefineOptions
  ): Promise<'approved' | 'skipped'> {
    // Show ticket info
    this.logger.info(`Ticket: [${ticket.id}] ${ticket.title}`);
    this.logger.info(`Project: ${ticket.projectName}`);

    // Validate project exists
    try {
      await this.persistence.getProject(ticket.projectName);
    } catch {
      this.logger.warning(`Project '${ticket.projectName}' not found. Skipping.`);
      return 'skipped';
    }

    // Confirm before starting AI session (skip in auto mode)
    if (!options?.auto) {
      const proceed = await this.ui.confirm(
        `Start ${this.aiSession.getProviderDisplayName()} refinement session for this ticket?`,
        true
      );
      if (!proceed) {
        return 'skipped';
      }
    }

    // Fetch issue data if ticket has a link
    let issueContext = '';
    if (ticket.link) {
      const spinner = this.logger.spinner('Fetching issue data...');
      try {
        const issue = await this.external.fetchIssue(ticket.link);
        if (issue) {
          issueContext = this.external.formatIssueContext(issue);
          spinner.succeed(`Issue data fetched (${String(issue.comments.length)} comment(s))`);
        } else {
          spinner.stop();
        }
      } catch {
        spinner.fail('Could not fetch issue data');
        this.logger.warning('Continuing without issue context');
      }
    }

    // Prepare AI session
    const refineDir = this.fs.getRefinementDir(sprint.id, ticket.id);
    await this.fs.ensureDir(refineDir);
    const outputFile = `${refineDir}/requirements.json`;
    const ticketContent = this.formatTicketForPrompt(ticket);
    const prompt = this.promptBuilder.buildRefinePrompt(ticketContent, outputFile, schema, issueContext);

    // Run AI session
    const ticketLog = this.logger.child({ sprintId: sprint.id, ticketId: ticket.id });
    const spinner = ticketLog.spinner(`Starting ${this.aiSession.getProviderDisplayName()} session...`);
    try {
      const stopSession = ticketLog.time('ai-refine-session');
      if (options?.auto) {
        const result = await this.aiSession.spawnHeadless(prompt, { cwd: refineDir });
        stopSession();
        spinner.succeed(`${this.aiSession.getProviderDisplayName()} session completed`);

        // In auto mode, parse from stdout output
        return await this.processRequirementsFromOutput(sprint, ticket, result.output);
      } else {
        // Write context file for interactive session
        await this.fs.writeFile(`${refineDir}/refine-context.md`, prompt);
        const startPrompt = `I need help refining the requirements for "${ticket.title}". The full context is in refine-context.md. Please read that file now and follow the instructions to help refine the ticket requirements.`;
        await this.aiSession.spawnInteractive(startPrompt, { cwd: refineDir });
        stopSession();
        spinner.succeed(`${this.aiSession.getProviderDisplayName()} session completed`);

        // In interactive mode, read from output file
        return await this.processRequirementsFromFile(sprint, ticket, outputFile);
      }
    } catch (err) {
      spinner.fail(`${this.aiSession.getProviderDisplayName()} session failed`);
      ticketLog.error(err instanceof Error ? err.message : String(err));
      return 'skipped';
    }
  }

  private async processRequirementsFromFile(
    sprint: Sprint,
    ticket: Ticket,
    outputFile: string
  ): Promise<'approved' | 'skipped'> {
    const exists = await this.fs.fileExists(outputFile);
    if (!exists) {
      this.logger.warning('No requirements file found from AI session.');
      return 'skipped';
    }

    const content = await this.fs.readFile(outputFile);
    return this.processRequirementsFromOutput(sprint, ticket, content);
  }

  private async processRequirementsFromOutput(
    sprint: Sprint,
    ticket: Ticket,
    output: string
  ): Promise<'approved' | 'skipped'> {
    let refinedRequirements: RefinedRequirement[];
    try {
      refinedRequirements = this.parser.parseRequirements(output);
    } catch {
      this.logger.warning('Failed to parse requirements output.');
      return 'skipped';
    }

    if (refinedRequirements.length === 0) {
      this.logger.warning('No requirements found in output.');
      return 'skipped';
    }

    // Find matching requirements
    const matching = refinedRequirements.filter((r) => r.ref === ticket.id || r.ref === ticket.title);

    if (matching.length === 0) {
      this.logger.warning('Requirement reference does not match this ticket.');
      return 'skipped';
    }

    // Combine multiple requirements into one
    const combined = this.combineRequirements(matching);

    // Show and confirm approval
    this.logger.info(`Refined requirements:\n${combined.requirements}`);

    const approve = await this.ui.confirm('Approve these requirements?', true);
    if (!approve) {
      return 'skipped';
    }

    // Save approved requirements
    const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
    const ticketToSave = sprint.tickets[ticketIdx];
    if (ticketIdx !== -1 && ticketToSave) {
      ticketToSave.requirements = combined.requirements;
      ticketToSave.requirementStatus = 'approved';
    }
    await this.persistence.saveSprint(sprint);

    this.logger.success('Requirements approved and saved!');
    return 'approved';
  }

  private combineRequirements(requirements: RefinedRequirement[]): RefinedRequirement {
    if (requirements.length === 1) {
      return {
        ref: requirements[0]?.ref ?? '',
        requirements: requirements[0]?.requirements ?? '',
      };
    }

    return {
      ref: requirements[0]?.ref ?? '',
      requirements: requirements
        .map((r, idx) => {
          const text = r.requirements.trim();
          if (/^#\s/.test(text)) return text;
          return `# ${String(idx + 1)}. Section ${String(idx + 1)}\n\n${text}`;
        })
        .join('\n\n---\n\n'),
    };
  }

  private formatTicketForPrompt(ticket: Ticket): string {
    const lines: string[] = [];
    lines.push(`### [${ticket.id}] ${ticket.title}`);
    lines.push(`Project: ${ticket.projectName}`);

    if (ticket.description) {
      lines.push('');
      lines.push('**Description:**');
      lines.push(ticket.description);
    }
    if (ticket.link) {
      lines.push('');
      lines.push(`**Link:** ${ticket.link}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  private async exportRequirements(sprint: Sprint): Promise<void> {
    const sprintDir = this.fs.getSprintDir(sprint.id);
    const outputPath = `${sprintDir}/requirements.md`;

    const lines: string[] = [];
    lines.push(`# Requirements: ${sprint.name}`);
    lines.push('');

    for (const ticket of sprint.tickets) {
      lines.push(`## [${ticket.id}] ${ticket.title}`);
      lines.push('');
      if (ticket.requirements) {
        lines.push(ticket.requirements);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    try {
      await this.fs.writeFile(outputPath, lines.join('\n'));
    } catch {
      this.logger.warning('Failed to export requirements markdown.');
    }
  }
}
