import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { colors, info } from '@src/theme/index.ts';
import {
  createSpinner,
  emoji,
  field,
  fieldMultiline,
  icons,
  log,
  printHeader,
  printSeparator,
  progressBar,
  renderCard,
  showError,
  showSuccess,
  showTip,
  showWarning,
} from '@src/theme/ui.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { getPendingRequirements } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { buildTicketRefinePrompt } from '@src/ai/prompts/index.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getRefinementDir, getSchemaPath, getSprintDir } from '@src/utils/paths.ts';
import { fetchIssueFromUrl, formatIssueContext, IssueFetchError } from '@src/utils/issue-fetch.ts';
import { type RefinedRequirement } from '@src/schemas/index.ts';
import { exportRequirementsToMarkdown } from '@src/utils/requirements-export.ts';
import { providerDisplayName, resolveProvider } from '@src/utils/provider.ts';
import { formatTicketForPrompt, parseRequirementsFile, runAiSession } from '@src/commands/ticket/refine-utils.ts';

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

export async function sprintRefineCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showTip('Specify a sprint ID or create one first.');
    log.newline();
    return;
  }
  const id = idR.value;

  const sprint = await getSprint(id);

  // Check sprint status - must be draft to refine
  try {
    assertSprintStatus(sprint, ['draft'], 'refine');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    log.newline();
    return;
  }

  if (sprint.tickets.length === 0) {
    showWarning('No tickets in sprint.');
    showTip('Add tickets first: ralphctl ticket add --project <project-name>');
    log.newline();
    return;
  }

  // Get pending tickets (filter by project if specified)
  let pendingTickets = getPendingRequirements(sprint.tickets);
  if (options.project) {
    pendingTickets = pendingTickets.filter((t) => t.projectName === options.project);
    if (pendingTickets.length === 0) {
      showWarning(`No pending tickets for project: ${options.project}`);
      log.newline();
      return;
    }
  }

  if (pendingTickets.length === 0) {
    showSuccess('All tickets already have approved requirements!');
    showTip('Run "ralphctl sprint plan" to generate tasks.');
    log.newline();
    return;
  }

  // Show initial summary
  printHeader('Requirements Refinement', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Pending', `${String(pendingTickets.length)} ticket(s)`));
  log.newline();

  // Load schema once before processing tickets
  const schemaPath = getSchemaPath('requirements-output.schema.json');
  const schema = await readFile(schemaPath, 'utf-8');

  // Resolve AI provider for display names
  const providerName = providerDisplayName(await resolveProvider());

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
    console.log(
      `  ${progressBar(i, totalTickets, {
        width: 15,
        showPercent: false,
      })} ${colors.muted(`${String(ticketNum)}/${String(totalTickets)}`)}`
    );
    console.log('');
    console.log(field('Title', ticket.title, 14));
    console.log(field('Project', ticket.projectName, 14));
    if (ticket.link) {
      console.log(field('Link', ticket.link, 14));
    }
    if (ticket.description) {
      console.log(fieldMultiline('Description', ticket.description, 14));
    }
    log.newline();

    // Validate project exists
    const projectR = await wrapAsync(() => getProject(ticket.projectName), ensureError);
    if (!projectR.ok) {
      showWarning(`Project '${ticket.projectName}' not found.`);
      log.dim('Skipping this ticket.');
      log.newline();
      skipped++;
      continue;
    }

    // Confirm before starting AI session
    const proceed = await confirm({
      message: `${emoji.donut} Start ${providerName} refinement session for this ticket?`,
      default: true,
    });

    if (!proceed) {
      log.dim('Skipped. You can refine this ticket later.');
      log.newline();
      skipped++;
      continue;
    }

    // Fetch live issue data if ticket has an issue link
    let issueContext = '';
    if (ticket.link) {
      const fetchSpinner = createSpinner('Fetching issue data...');
      fetchSpinner.start();
      const link = ticket.link;
      const issueR = Result.try(() => fetchIssueFromUrl(link));
      if (issueR.ok && issueR.value) {
        issueContext = formatIssueContext(issueR.value);
        fetchSpinner.succeed(`Issue data fetched (${String(issueR.value.comments.length)} comment(s))`);
      } else if (!issueR.ok) {
        fetchSpinner.fail('Could not fetch issue data');
        if (issueR.error instanceof IssueFetchError) {
          showWarning(`${issueR.error.message} — continuing without issue context`);
        } else {
          showWarning(`${issueR.error.message} — continuing without issue context`);
        }
      } else {
        fetchSpinner.stop();
      }
    }

    // Prepare AI session - use sprint's refinement directory
    const refineDir = getRefinementDir(id, ticket.id);
    await mkdir(refineDir, { recursive: true });
    const outputFile = join(refineDir, 'requirements.json');
    const ticketContent = formatTicketForPrompt(ticket);
    const prompt = buildTicketRefinePrompt(ticketContent, outputFile, schema, issueContext);

    log.dim(`Working directory: ${refineDir}`);
    log.dim(`Requirements output: ${outputFile}`);
    log.newline();

    const spinner = createSpinner(`Starting ${providerName} session...`);
    spinner.start();

    const sessionR = await wrapAsync(() => runAiSession(refineDir, prompt, ticket.title), ensureError);
    if (!sessionR.ok) {
      spinner.fail(`${providerName} session failed`);
      showError(sessionR.error.message);
      log.newline();
      skipped++;
      continue;
    }
    spinner.succeed(`${providerName} session completed`);

    log.newline();

    // Process the requirements file
    if (await fileExists(outputFile)) {
      const contentR = await wrapAsync(() => readFile(outputFile, 'utf-8'), ensureError);
      if (!contentR.ok) {
        showError(`Failed to read requirements file: ${outputFile}`);
        log.newline();
        skipped++;
        continue;
      }

      const parseR = Result.try(() => parseRequirementsFile(contentR.value));
      if (!parseR.ok) {
        showError(`Failed to parse requirements file: ${parseR.error.message}`);
        log.newline();
        skipped++;
        continue;
      }
      const refinedRequirements: RefinedRequirement[] = parseR.value;

      if (refinedRequirements.length === 0) {
        showWarning('No requirements found in output file.');
        log.newline();
        skipped++;
        continue;
      }

      // Find all matching requirements (Claude may output multiple for one ticket)
      const matchingRequirements = refinedRequirements.filter((r) => r.ref === ticket.id || r.ref === ticket.title);

      if (matchingRequirements.length === 0) {
        showWarning('Requirement reference does not match this ticket.');
        log.newline();
        skipped++;
        continue;
      }

      // Combine multiple requirements into one (safety net for split outputs)
      const requirement: RefinedRequirement =
        matchingRequirements.length === 1
          ? {
              ref: matchingRequirements[0]?.ref ?? '',
              requirements: matchingRequirements[0]?.requirements ?? '',
            }
          : {
              ref: matchingRequirements[0]?.ref ?? '',
              requirements: matchingRequirements
                .map((r, idx) => {
                  const text = r.requirements.trim();
                  if (/^#\s/.test(text)) return text;
                  return `# ${String(idx + 1)}. Section ${String(idx + 1)}\n\n${text}`;
                })
                .join('\n\n---\n\n'),
            };

      // Show requirement for review
      const reqLines = requirement.requirements.split('\n');
      console.log(renderCard(`${icons.ticket} Refined Requirements`, reqLines));
      log.newline();

      const approveRequirement = await confirm({
        message: `${emoji.donut} Approve these requirements?`,
        default: true,
      });

      if (approveRequirement) {
        // Save requirements to ticket
        const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
        const ticketToSave = sprint.tickets[ticketIdx];
        if (ticketIdx !== -1 && ticketToSave) {
          ticketToSave.requirements = requirement.requirements;
          ticketToSave.requirementStatus = 'approved';
        }
        await saveSprint(sprint);
        showSuccess('Requirements approved and saved!');
        approved++;
      } else {
        log.dim('Requirements not approved. You can refine this ticket later.');
        skipped++;
      }
    } else {
      showWarning('No requirements file found from AI session.');
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

  // Re-read sprint to get the latest state after all saves
  const updatedSprint = await getSprint(id);
  const remainingPending = getPendingRequirements(updatedSprint.tickets);

  if (remainingPending.length === 0) {
    showSuccess('All requirements approved!');

    // Auto-export requirements to sprint directory
    const sprintDir = getSprintDir(id);
    const outputPath = join(sprintDir, 'requirements.md');

    const exportR = await wrapAsync(() => exportRequirementsToMarkdown(updatedSprint, outputPath), ensureError);
    if (exportR.ok) {
      log.dim(`Requirements saved to: ${outputPath}`);
    } else {
      showError(`Failed to write requirements: ${exportR.error.message}`);
    }

    showTip('Run "ralphctl sprint plan" to generate tasks.');
  } else {
    log.info(`${String(remainingPending.length)} ticket(s) still pending.`);
    showTip('Continue refinement with: ralphctl sprint refine');
  }
  log.newline();
}
