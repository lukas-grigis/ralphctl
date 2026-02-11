import { confirm, input, select } from '@inquirer/prompts';
import { error, muted } from '@src/theme/index.ts';
import {
  emoji,
  field,
  fieldMultiline,
  icons,
  log,
  showEmpty,
  showError,
  showNextStep,
  showSuccess,
} from '@src/theme/ui.ts';
import { multilineInput } from '@src/utils/multiline.ts';
import { addTicket, DuplicateTicketError } from '@src/store/ticket.ts';
import { listProjects, projectExists } from '@src/store/project.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';
import type { Ticket } from '@src/schemas/index.ts';

export interface TicketAddOptions {
  externalId?: string;
  title?: string;
  description?: string;
  link?: string;
  project?: string;
  useEditor?: boolean;
  interactive?: boolean; // Set by REPL or CLI (default true unless --no-interactive)
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

  const trimmedExternalId = options.externalId?.trim();
  const externalId = trimmedExternalId === '' ? undefined : trimmedExternalId;
  const title = trimmedTitle;
  const trimmedDesc = options.description?.trim();
  const description = trimmedDesc === '' ? undefined : trimmedDesc;
  const trimmedLink = options.link?.trim();
  const link = trimmedLink === '' ? undefined : trimmedLink;
  const projectName = trimmedProject;

  try {
    const ticket = await addTicket({
      externalId,
      title,
      description,
      link,
      projectName,
    });

    showTicketResult(ticket);
  } catch (err) {
    handleTicketError(err, externalId);
  }
}

/**
 * Interactive ticket creation: prompts for fields and creates ticket.
 * Returns the created ticket on success, or null on failure.
 */
async function addSingleTicketInteractive(options: TicketAddOptions): Promise<Ticket | null> {
  const { useEditor = false } = options;

  const projects = await listProjects();

  if (projects.length === 0) {
    showEmpty('projects', 'Add one first with: ralphctl project add');
    return null;
  }

  const defaultProjectIndex = options.project ? projects.findIndex((p) => p.name === options.project) : -1;

  const projectName = await select({
    message: `${icons.project} Project:`,
    default: defaultProjectIndex >= 0 ? defaultProjectIndex : 0,
    choices: projects.map((p) => ({
      name: `${icons.project} ${p.name} ${muted(`- ${p.displayName}`)}`,
      value: p.name,
    })),
  });

  let externalId: string | undefined = await input({
    message: `${icons.info} External ID (optional, e.g., JIRA-123):`,
    default: options.externalId?.trim(),
  });

  let title = await input({
    message: `${icons.ticket} Title:`,
    default: options.title?.trim(),
    validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
  });

  let description: string | undefined;
  if (useEditor) {
    const { editor } = await import('@inquirer/prompts');
    description = await editor({
      message: `${icons.edit} Description (opens editor):`,
      default: options.description?.trim(),
    });
  } else {
    description = await multilineInput({
      message: 'Description (recommended):',
      default: options.description?.trim(),
    });
  }

  let link: string | undefined = await input({
    message: `${icons.info} Link (optional):`,
    default: options.link?.trim(),
    validate: (v) => {
      if (!v) return true;
      return validateUrl(v) ? true : 'Invalid URL format';
    },
  });

  // Trim and normalize empty strings to undefined
  const trimmedExternalId = externalId.trim();
  externalId = trimmedExternalId === '' ? undefined : trimmedExternalId;
  title = title.trim();
  const trimmedDescription = description.trim();
  description = trimmedDescription === '' ? undefined : trimmedDescription;
  const trimmedLink = link.trim();
  link = trimmedLink === '' ? undefined : trimmedLink;

  try {
    const ticket = await addTicket({
      externalId,
      title,
      description,
      link,
      projectName,
    });

    showTicketResult(ticket);
    return ticket;
  } catch (err) {
    handleTicketError(err, externalId);
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

  if (ticket.externalId) {
    console.log(field('External', ticket.externalId));
  }
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
function handleTicketError(err: unknown, externalId: string | undefined): void {
  if (err instanceof DuplicateTicketError) {
    showError(`Ticket with external ID "${externalId ?? ''}" already exists`);
    showNextStep('ralphctl ticket list', 'see existing tickets');
  } else if (err instanceof SprintStatusError) {
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
    }

    const another = await confirm({
      message: `${emoji.donut} Add another ticket?`,
      default: true,
    });
    if (!another) break;
  }
}
