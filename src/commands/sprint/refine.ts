import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkbox, confirm } from '@inquirer/prompts';
import { info } from '@src/theme/index.ts';
import {
  createSpinner,
  emoji,
  field,
  fieldMultiline,
  icons,
  log,
  printHeader,
  printSeparator,
  showError,
  showSuccess,
  showWarning,
} from '@src/theme/ui.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { formatTicketDisplay, getPendingTickets } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { buildSpecRefinePrompt } from '@src/claude/prompts/index.ts';
import { spawnClaudeInteractive } from '@src/claude/session.ts';
import { fileExists } from '@src/utils/storage.ts';
import type { Repository, Ticket } from '@src/schemas/index.ts';

interface RefineOptions {
  project?: string;
}

function parseArgs(args: string[]): { sprintId?: string; options: RefineOptions } {
  const options: RefineOptions = {};
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--project') {
      options.project = nextArg;
      i++;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

/**
 * Format a single ticket for the Claude prompt, including only affected repositories.
 */
function formatTicketForPrompt(ticket: Ticket, affectedRepos: Repository[]): string {
  const lines: string[] = [];

  lines.push(`### ${formatTicketDisplay(ticket)}`);
  lines.push(`Project: ${ticket.projectName}`);

  // List only affected repositories
  const repoPaths = affectedRepos.map((r) => `${r.name} (${r.path})`);
  lines.push(`Affected Repositories: ${repoPaths.join(', ')}`);

  if (ticket.externalId) {
    lines.push(`External ID: ${ticket.externalId}`);
  }

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

interface RefinedSpec {
  ref: string;
  specs: string;
}

function parseSpecsFile(content: string): RefinedSpec[] {
  // Try to extract JSON array from the content
  const jsonMatch = /\[[\s\S]*\]/.exec(content);
  if (!jsonMatch) {
    throw new Error('No JSON array found in specs file');
  }

  const parsed = JSON.parse(jsonMatch[0]) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }

  return parsed as RefinedSpec[];
}

async function runClaudeSession(
  primaryPath: string,
  additionalPaths: string[],
  prompt: string,
  ticketTitle: string
): Promise<void> {
  // Write full context to a file for reference
  const contextFile = join(primaryPath, '.ralphctl-refine-context.md');
  await writeFile(contextFile, prompt, 'utf-8');

  // Build initial prompt that tells Claude to read the context file
  const startPrompt = `I need help refining the specification for "${ticketTitle}". The full context is in .ralphctl-refine-context.md. Please read that file now and follow the instructions to help refine the ticket specification.`;

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

export async function sprintRefineCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    showWarning('No sprint specified and no current sprint set.');
    log.dim('Specify a sprint ID or create one first.');
    log.newline();
    return;
  }

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to refine
  try {
    assertSprintStatus(sprint, ['draft'], 'refine');
  } catch (err) {
    if (err instanceof Error) {
      showError(err.message);
      log.newline();
    }
    return;
  }

  if (sprint.tickets.length === 0) {
    showWarning('No tickets in sprint.');
    log.dim('Add tickets first: ralphctl ticket add --project <project-name>');
    log.newline();
    return;
  }

  // Get pending tickets (filter by project if specified)
  let pendingTickets = getPendingTickets(sprint.tickets);
  if (options.project) {
    pendingTickets = pendingTickets.filter((t) => t.projectName === options.project);
    if (pendingTickets.length === 0) {
      showWarning(`No pending tickets for project: ${options.project}`);
      log.newline();
      return;
    }
  }

  if (pendingTickets.length === 0) {
    showSuccess('All tickets already have approved specs!');
    log.dim('Run "ralphctl sprint plan" to generate tasks.');
    log.newline();
    return;
  }

  // Show initial summary
  printHeader('Spec Refinement', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Pending', `${String(pendingTickets.length)} ticket(s)`));
  log.newline();

  // Process tickets one by one
  let approved = 0;
  let skipped = 0;

  for (let i = 0; i < pendingTickets.length; i++) {
    const ticket = pendingTickets[i];
    if (!ticket) continue;

    const ticketNum = i + 1;
    const totalTickets = pendingTickets.length;

    // Show ticket card
    printSeparator(60);
    console.log('');
    console.log(`  ${icons.ticket}  ${info(`Ticket ${String(ticketNum)} of ${String(totalTickets)}`)}`);
    console.log('');
    console.log(field('Title', ticket.title, 14));
    console.log(field('Project', ticket.projectName, 14));
    if (ticket.externalId) {
      console.log(field('External ID', ticket.externalId, 14));
    }
    if (ticket.link) {
      console.log(field('Link', ticket.link, 14));
    }
    if (ticket.description) {
      console.log(fieldMultiline('Description', ticket.description, 14));
    }
    log.newline();

    // Get project repositories
    let projectRepos: Repository[];
    try {
      const project = await getProject(ticket.projectName);
      projectRepos = project.repositories;
    } catch {
      showWarning(`Project '${ticket.projectName}' not found.`);
      log.dim('Skipping this ticket.');
      log.newline();
      skipped++;
      continue;
    }

    if (projectRepos.length === 0) {
      showWarning(`Project '${ticket.projectName}' has no repositories configured.`);
      log.dim('Skipping this ticket.');
      log.newline();
      skipped++;
      continue;
    }

    // Select affected repositories
    let affectedRepos: Repository[];
    const firstRepo = projectRepos[0];
    if (projectRepos.length === 1 && firstRepo) {
      // Auto-select single repo
      affectedRepos = [firstRepo];
      log.info(`Affected repository: ${firstRepo.name} (${firstRepo.path})`);
      log.newline();
    } else {
      // Multi-repo: ask user to select
      log.info('Which repositories does this ticket affect?');
      const selectedRepoNames = await checkbox({
        message: `${emoji.donut} Select affected repositories:`,
        choices: projectRepos.map((r, idx) => ({
          name: `${r.name} (${r.path})`,
          value: r.name,
          checked: idx === 0, // First repo checked by default
        })),
        required: true,
      });

      affectedRepos = projectRepos.filter((r) => selectedRepoNames.includes(r.name));
      if (affectedRepos.length === 0) {
        showWarning('No repositories selected.');
        skipped++;
        continue;
      }
    }

    // Store affected repositories in ticket and persist immediately
    const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
    const ticketToUpdate = sprint.tickets[ticketIdx];
    if (ticketIdx !== -1 && ticketToUpdate) {
      ticketToUpdate.affectedRepositories = affectedRepos.map((r) => r.name);
      await saveSprint(sprint); // Persist selection so it survives skips
    }

    // Confirm before starting Claude session
    const proceed = await confirm({
      message: `${emoji.donut} Start Claude refinement session for this ticket?`,
      default: true,
    });

    if (!proceed) {
      log.dim('Skipped. You can refine this ticket later.');
      log.newline();
      skipped++;
      continue;
    }

    // Prepare Claude session
    const outputFile = join(tmpdir(), `ralphctl-spec-${ticket.id}-${String(Date.now())}.json`);
    const ticketContent = formatTicketForPrompt(ticket, affectedRepos);
    const prompt = buildSpecRefinePrompt(ticketContent, outputFile);

    // Select primary/additional paths from affected repos
    const selectedPaths = affectedRepos.map((r) => r.path);
    const primaryPath = selectedPaths[0] ?? process.cwd();
    const additionalPaths = selectedPaths.slice(1);

    log.dim(`Primary path: ${primaryPath}`);
    if (additionalPaths.length > 0) {
      log.dim(`Additional paths: ${additionalPaths.join(', ')}`);
    }
    log.dim(`Spec output: ${outputFile}`);
    log.newline();

    const spinner = createSpinner('Starting Claude session...');
    spinner.start();

    try {
      await runClaudeSession(primaryPath, additionalPaths, prompt, ticket.title);
      spinner.succeed('Claude session completed');
    } catch (err) {
      spinner.fail('Claude session failed');
      if (err instanceof Error) {
        showError(err.message);
      }
      log.newline();
      skipped++;
      continue;
    }

    log.newline();

    // Process the spec file
    if (await fileExists(outputFile)) {
      let content: string;
      try {
        content = await readFile(outputFile, 'utf-8');
      } catch {
        showError(`Failed to read spec file: ${outputFile}`);
        log.newline();
        skipped++;
        continue;
      }

      let refinedSpecs: RefinedSpec[];
      try {
        refinedSpecs = parseSpecsFile(content);
      } catch (err) {
        if (err instanceof Error) {
          showError(`Failed to parse spec file: ${err.message}`);
        }
        log.newline();
        skipped++;
        continue;
      }

      if (refinedSpecs.length === 0) {
        showWarning('No spec found in output file.');
        log.newline();
        skipped++;
        continue;
      }

      // Find the matching spec (should be only one for single-ticket flow)
      const spec = refinedSpecs.find(
        (s) => s.ref === ticket.id || s.ref === ticket.externalId || s.ref === ticket.title
      );

      if (!spec) {
        showWarning('Spec reference does not match this ticket.');
        log.newline();
        skipped++;
        continue;
      }

      // Show spec for review
      printSeparator(60);
      console.log('');
      log.info('Refined Specification:');
      console.log('');
      console.log(spec.specs);
      console.log('');
      printSeparator(60);
      log.newline();

      const approveSpec = await confirm({
        message: `${emoji.donut} Approve this specification?`,
        default: true,
      });

      if (approveSpec) {
        // Save spec to ticket
        const ticketToSave = sprint.tickets[ticketIdx];
        if (ticketIdx !== -1 && ticketToSave) {
          ticketToSave.specs = spec.specs;
          ticketToSave.specStatus = 'approved';
        }
        await saveSprint(sprint);
        showSuccess('Specification approved and saved!');
        approved++;
      } else {
        log.dim('Specification not approved. You can refine this ticket later.');
        skipped++;
      }

      // Clean up temp file
      try {
        await unlink(outputFile);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      showWarning('No spec file found from Claude session.');
      log.dim('You can refine this ticket later.');
      skipped++;
    }

    log.newline();
  }

  // Final summary
  printSeparator(60);
  log.newline();
  printHeader('Summary', icons.success);
  console.log(field('Approved', String(approved)));
  console.log(field('Skipped', String(skipped)));
  console.log(field('Total', String(pendingTickets.length)));
  log.newline();

  const remainingPending = getPendingTickets(sprint.tickets);
  if (remainingPending.length === 0) {
    showSuccess('All specs approved!');
    log.dim('Run "ralphctl sprint plan" to generate tasks.');
  } else {
    log.info(`${String(remainingPending.length)} ticket(s) still pending.`);
    log.dim('Continue refinement with: ralphctl sprint refine');
  }
  log.newline();
}
