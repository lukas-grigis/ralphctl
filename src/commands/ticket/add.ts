import { confirm, input, select } from '@inquirer/prompts';
import { error, muted } from '@src/theme/index.ts';
import {
  createSpinner,
  emoji,
  field,
  fieldMultiline,
  icons,
  log,
  renderCard,
  showEmpty,
  showError,
  showSuccess,
  showWarning,
} from '@src/theme/ui.ts';
import { editorInput } from '@src/utils/editor-input.ts';
import { addTicket } from '@src/store/ticket.ts';
import { listProjects, projectExists } from '@src/store/project.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';
import { IssueFetchError, fetchIssueFromUrl, type IssueData } from '@src/utils/issue-fetch.ts';
import type { Ticket } from '@src/schemas/index.ts';

export interface TicketAddOptions {
  title?: string;
  description?: string;
  link?: string;
  project?: string;
  interactive?: boolean; // Set by REPL or CLI (default true unless --no-interactive)
}

/**
 * Attempt to fetch issue data from a URL. Returns the data if the user confirms,
 * undefined otherwise. Non-fatal — warns on failure and returns undefined.
 */
function tryFetchIssue(url: string): IssueData | undefined {
  const spinner = createSpinner('Fetching issue data...');
  spinner.start();

  let data: IssueData | null;
  try {
    data = fetchIssueFromUrl(url);
  } catch (err) {
    spinner.fail('Could not fetch issue data');
    if (err instanceof IssueFetchError) {
      showWarning(err.message);
    } else if (err instanceof Error) {
      showWarning(err.message);
    }
    log.newline();
    return undefined;
  }

  if (!data) {
    spinner.stop();
    return undefined;
  }

  spinner.succeed('Issue data fetched');
  log.newline();

  // Show summary card
  const bodyPreview = data.body.length > 200 ? data.body.slice(0, 200) + '...' : data.body;
  const cardLines = [`Title: ${data.title}`, '', bodyPreview];
  if (data.comments.length > 0) {
    cardLines.push('', `${String(data.comments.length)} comment(s)`);
  }
  console.log(renderCard(`${icons.info} Fetched Issue`, cardLines));
  log.newline();

  return data;
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-interactive ticket creation: validates params and creates ticket.
 */
async function addSingleTicketNonInteractive(options: TicketAddOptions): Promise<void> {
  const errors: string[] = [];
  const trimmedTitle = options.title?.trim();
  const trimmedProject = options.project?.trim();

  if (!trimmedTitle) {
    errors.push('--title is required');
  }
  if (!trimmedProject) {
    errors.push('--project is required');
  } else if (!(await projectExists(trimmedProject))) {
    errors.push(`Project '${trimmedProject}' does not exist. Add it first with 'ralphctl project add'.`);
  }
  if (options.link && !validateUrl(options.link)) {
    errors.push('--link must be a valid URL');
  }

  if (errors.length > 0 || !trimmedTitle || !trimmedProject) {
    showError('Validation failed');
    for (const e of errors) {
      log.item(error(e));
    }
    log.newline();
    exitWithCode(EXIT_ERROR);
  }

  const title = trimmedTitle;
  const trimmedDesc = options.description?.trim();
  const description = trimmedDesc === '' ? undefined : trimmedDesc;
  const trimmedLink = options.link?.trim();
  const link = trimmedLink === '' ? undefined : trimmedLink;
  const projectName = trimmedProject;

  try {
    const ticket = await addTicket({
      title,
      description,
      link,
      projectName,
    });

    showTicketResult(ticket);
  } catch (err) {
    handleTicketError(err);
  }
}

/**
 * Interactive ticket creation: prompts for fields and creates ticket.
 * Returns the created ticket on success, or null on failure.
 */
export async function addSingleTicketInteractive(options: TicketAddOptions): Promise<Ticket | null> {
  const projects = await listProjects();

  if (projects.length === 0) {
    showEmpty('projects', 'Add one first with: ralphctl project add');
    return null;
  }

  const projectName = await select({
    message: `${icons.project} Project:`,
    default: options.project ?? projects[0]?.name,
    choices: projects.map((p) => ({
      name: `${icons.project} ${p.name} ${muted(`- ${p.displayName}`)}`,
      value: p.name,
    })),
  });

  // Link prompt first — enables issue fetching for pre-fill
  const link: string | undefined = await input({
    message: `${icons.info} Issue link (optional):`,
    default: options.link?.trim(),
    validate: (v) => {
      if (!v) return true;
      return validateUrl(v) ? true : 'Invalid URL format';
    },
  });

  const trimmedLink = link.trim();
  const normalizedLink = trimmedLink === '' ? undefined : trimmedLink;

  // Try to fetch issue data if a valid issue URL was provided
  let prefill: IssueData | undefined;
  if (normalizedLink) {
    prefill = tryFetchIssue(normalizedLink);
  }

  let title = await input({
    message: `${icons.ticket} Title:`,
    default: prefill?.title ?? options.title?.trim(),
    validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
  });

  const description = await editorInput({
    message: 'Description (recommended):',
    default: prefill?.body ?? options.description?.trim(),
  });

  // Trim and normalize empty strings to undefined
  title = title.trim();
  const trimmedDescription = description.trim();
  const normalizedDescription = trimmedDescription === '' ? undefined : trimmedDescription;

  try {
    const ticket = await addTicket({
      title,
      description: normalizedDescription,
      link: normalizedLink,
      projectName,
    });

    showTicketResult(ticket);
    return ticket;
  } catch (err) {
    handleTicketError(err);
    return null;
  }
}

/**
 * Display the result of a successfully added ticket.
 */
function showTicketResult(ticket: Ticket): void {
  showSuccess('Ticket added!', [
    ['ID', ticket.id],
    ['Title', ticket.title],
    ['Project', ticket.projectName],
  ]);

  if (ticket.description) {
    console.log(fieldMultiline('Description', ticket.description));
  }
  if (ticket.link) {
    console.log(field('Link', ticket.link));
  }
  console.log('');
}

/**
 * Handle known ticket creation errors with user-friendly messages.
 */
function handleTicketError(err: unknown): void {
  if (err instanceof SprintStatusError) {
    showError(err.message);
  } else if (err instanceof Error && err.message.includes('does not exist')) {
    showError(err.message);
  } else {
    throw err;
  }
}

export async function ticketAddCommand(options: TicketAddOptions = {}): Promise<void> {
  if (options.interactive === false) {
    await addSingleTicketNonInteractive(options);
    return;
  }

  // Interactive mode with batch loop
  let count = 0;
  let lastProjectName: string | undefined = options.project;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control via break
  while (true) {
    const ticket = await addSingleTicketInteractive({ ...options, project: lastProjectName });
    if (ticket) {
      count++;
      lastProjectName = ticket.projectName;
      log.dim(`${String(count)} ticket(s) added in this session`);
    } else {
      // No ticket created (no projects, or unrecoverable error) — exit loop
      break;
    }

    const another = await confirm({
      message: `${emoji.donut} Add another ticket?`,
      default: true,
    });
    if (!another) break;
  }
}
