import {
  getRequirementsOutputJsonSchema,
  type RefinedRequirement,
  type Sprint,
  type Ticket,
} from '@src/domain/models.ts';
import { DomainError, ParseError, SprintStatusError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { RefineOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';

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
      // Resolve provider once so the sync getters (getProviderDisplayName etc.)
      // are safe to call in spinner labels and confirm prompts below.
      await this.aiSession.ensureReady();

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

      // 2. Get pending tickets. The sprint is scoped to exactly one project
      // (sprint.projectId); the `--project` filter is retained as a legacy
      // knob but is either a match for the sprint's project or a no-op.
      let pendingTickets = sprint.tickets.filter((t) => t.requirementStatus === 'pending');

      if (options?.project) {
        try {
          const filterProject = await this.persistence.getProject(options.project);
          if (filterProject.id !== sprint.projectId) {
            pendingTickets = [];
          }
        } catch {
          pendingTickets = [];
        }
      }

      if (pendingTickets.length === 0) {
        const allApproved = sprint.tickets.every((t) => t.requirementStatus === 'approved');
        return Result.ok({ approved: 0, skipped: 0, total: 0, allApproved });
      }

      // JSON schema generated from the Zod source of truth — no hand-maintained
      // mirror file to drift.
      const schema = getRequirementsOutputJsonSchema();

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

      // 4. Determine whether every ticket is now approved. Exporting the
      // requirements markdown is the pipeline's job (see
      // `src/business/pipelines/refine.ts` `export-requirements` step) — this
      // use case only reports the state.
      const updatedSprint = await this.persistence.getSprint(sprintId);
      const remainingPending = updatedSprint.tickets.filter((t) => t.requirementStatus === 'pending');
      const allApproved = remainingPending.length === 0;

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

  /**
   * Export the sprint's approved requirements to `requirements.md`.
   *
   * Called by the `export-requirements` pipeline step after `execute()`
   * reports `allApproved`. Kept on the use case (rather than inlined into
   * the step) so the file-layout / formatting concerns live with the rest
   * of the refinement workflow. Failures are swallowed with a warning —
   * the markdown export is a convenience artifact, not a correctness
   * guarantee.
   */
  async exportRequirements(sprint: Sprint): Promise<void> {
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

  private async processTicket(
    sprint: Sprint,
    ticket: Ticket,
    schema: string,
    options?: RefineOptions
  ): Promise<'approved' | 'skipped'> {
    // Show ticket info
    this.logger.info(`Ticket: [${ticket.id}] ${ticket.title}`);

    // Validate sprint's project exists
    let project;
    try {
      project = await this.persistence.getProjectById(sprint.projectId);
      this.logger.info(`Project: ${project.name}`);
    } catch {
      this.logger.warning(`Project (id=${sprint.projectId}) not found. Skipping.`);
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

    // Show the refined requirements inline in the confirm prompt so the user
    // reviews the actual content before approving (rendered as a bordered
    // block above the Y/n line by `ConfirmPrompt`).
    const approve = await this.ui.confirm('Approve these requirements?', true, combined.requirements);
    if (!approve) {
      this.logger.warning(
        `Requirements rejected for ticket [${ticket.id}]. Re-run \`sprint refine\` to start fresh (resume is not yet supported).`
      );
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
}
