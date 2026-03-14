import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import {
  createSpinner,
  emoji,
  field,
  fieldMultiline,
  icons,
  log,
  printHeader,
  renderCard,
  showError,
  showSuccess,
  showTip,
  showWarning,
} from '@src/theme/ui.ts';
import { assertSprintStatus, getSprint, resolveSprintId, saveSprint } from '@src/store/sprint.ts';
import { formatTicketDisplay } from '@src/store/ticket.ts';
import { buildTicketRefinePrompt } from '@src/ai/prompts/index.ts';
import { fileExists } from '@src/utils/storage.ts';
import { getRefinementDir, getSchemaPath } from '@src/utils/paths.ts';
import { fetchIssueFromUrl, formatIssueContext } from '@src/utils/issue-fetch.ts';
import { type RefinedRequirement } from '@src/schemas/index.ts';
import { resolveProvider, providerDisplayName } from '@src/utils/provider.ts';
import { formatTicketForPrompt, parseRequirementsFile, runAiSession } from './refine-utils.ts';
import { selectTicket } from '@src/interactive/selectors.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';

export interface TicketRefineOptions {
  interactive?: boolean;
}

export async function ticketRefineCommand(ticketId?: string, options: TicketRefineOptions = {}): Promise<void> {
  const isInteractive = options.interactive !== false;

  // Resolve sprint
  const sprintIdR = await wrapAsync(() => resolveSprintId(), ensureError);
  if (!sprintIdR.ok) {
    showWarning('No current sprint set.');
    showTip('Create a sprint first or set one with: ralphctl sprint current');
    log.newline();
    return;
  }
  const sprintId = sprintIdR.value;

  const sprint = await getSprint(sprintId);

  // Must be draft
  try {
    assertSprintStatus(sprint, ['draft'], 'refine ticket');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    log.newline();
    return;
  }

  // Find approved tickets
  const approvedTickets = sprint.tickets.filter((t) => t.requirementStatus === 'approved');
  if (approvedTickets.length === 0) {
    showWarning('No approved tickets to re-refine.');
    showTip('Run "ralphctl sprint refine" to refine pending tickets first.');
    log.newline();
    return;
  }

  // Resolve ticket ID
  let resolvedId = ticketId;
  if (!resolvedId) {
    if (!isInteractive) {
      showError('Ticket ID is required in non-interactive mode');
      exitWithCode(EXIT_ERROR);
    }

    const selected = await selectTicket('Select ticket to re-refine:', (t) => t.requirementStatus === 'approved');
    if (!selected) return;
    resolvedId = selected;
  }

  // Find the ticket
  const ticket = sprint.tickets.find((t) => t.id === resolvedId);
  if (!ticket) {
    showError(`Ticket not found: ${resolvedId}`);
    if (!isInteractive) exitWithCode(EXIT_ERROR);
    return;
  }

  if (ticket.requirementStatus !== 'approved') {
    showError('Only approved tickets can be re-refined. Run "ralphctl sprint refine" for pending tickets.');
    if (!isInteractive) exitWithCode(EXIT_ERROR);
    return;
  }

  // Show ticket info
  printHeader('Re-Refine Ticket', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('Ticket', formatTicketDisplay(ticket)));
  console.log(field('Project', ticket.projectName));
  if (ticket.link) {
    console.log(field('Link', ticket.link));
  }
  if (ticket.description) {
    console.log(fieldMultiline('Description', ticket.description));
  }
  log.newline();

  // Load schema
  const schemaPath = getSchemaPath('requirements-output.schema.json');
  const schema = await readFile(schemaPath, 'utf-8');

  const providerName = providerDisplayName(await resolveProvider());

  // Confirm before starting AI session
  const proceed = await confirm({
    message: `${emoji.donut} Start ${providerName} re-refinement session?`,
    default: true,
  });

  if (!proceed) {
    log.dim('Cancelled.');
    log.newline();
    return;
  }

  // Fetch live issue data if ticket has a link
  let issueContext = '';
  if (ticket.link) {
    const ticketLink = ticket.link;
    const fetchSpinner = createSpinner('Fetching issue data...');
    fetchSpinner.start();
    const fetchR = Result.try(() => fetchIssueFromUrl(ticketLink));
    if (!fetchR.ok) {
      fetchSpinner.fail('Could not fetch issue data');
      showWarning(`${fetchR.error.message} — continuing without issue context`);
    } else if (fetchR.value) {
      issueContext = formatIssueContext(fetchR.value);
      fetchSpinner.succeed(`Issue data fetched (${String(fetchR.value.comments.length)} comment(s))`);
    } else {
      fetchSpinner.stop();
    }
  }

  // Build prompt with existing requirements as context
  const refineDir = getRefinementDir(sprintId, ticket.id);
  await mkdir(refineDir, { recursive: true });
  const outputFile = join(refineDir, 'requirements.json');

  let ticketContent = formatTicketForPrompt(ticket);
  if (ticket.requirements) {
    ticketContent += '\n### Previously Approved Requirements\n\n';
    ticketContent += ticket.requirements;
    ticketContent += '\n';
  }

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
    return;
  }
  spinner.succeed(`${providerName} session completed`);

  log.newline();

  // Process the requirements file
  if (!(await fileExists(outputFile))) {
    showWarning('No requirements file found from AI session.');
    log.newline();
    return;
  }

  const contentR = await wrapAsync(() => readFile(outputFile, 'utf-8'), ensureError);
  if (!contentR.ok) {
    showError(`Failed to read requirements file: ${outputFile}`);
    log.newline();
    return;
  }
  const content = contentR.value;

  const parseR = Result.try(() => parseRequirementsFile(content));
  if (!parseR.ok) {
    showError(`Failed to parse requirements file: ${parseR.error.message}`);
    log.newline();
    return;
  }
  const refinedRequirements = parseR.value;

  if (refinedRequirements.length === 0) {
    showWarning('No requirements found in output file.');
    log.newline();
    return;
  }

  // Find matching requirements
  const matchingRequirements = refinedRequirements.filter((r) => r.ref === ticket.id || r.ref === ticket.title);

  if (matchingRequirements.length === 0) {
    showWarning('Requirement reference does not match this ticket.');
    log.newline();
    return;
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
  console.log(renderCard(`${icons.ticket} Re-Refined Requirements`, reqLines));
  log.newline();

  const approveRequirement = await confirm({
    message: `${emoji.donut} Approve these requirements?`,
    default: true,
  });

  if (approveRequirement) {
    const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticket.id);
    const ticketToSave = sprint.tickets[ticketIdx];
    if (ticketIdx !== -1 && ticketToSave) {
      ticketToSave.requirements = requirement.requirements;
      // Keep requirementStatus as 'approved'
    }
    await saveSprint(sprint);
    showSuccess('Requirements updated and saved!');
  } else {
    log.dim('Requirements not approved. Previous requirements unchanged.');
  }

  log.newline();
}
