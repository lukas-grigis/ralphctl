import { input } from '@inquirer/prompts';
import { muted } from '@src/theme/index.ts';
import { field, fieldMultiline, icons, showError, showSuccess } from '@src/theme/ui.ts';
import {
  DuplicateTicketError,
  formatTicketDisplay,
  getTicket,
  TicketNotFoundError,
  updateTicket,
} from '@src/store/ticket.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';
import { selectTicket } from '@src/interactive/selectors.ts';
import { multilineInput } from '@src/utils/multiline.ts';

export interface TicketEditOptions {
  externalId?: string;
  title?: string;
  description?: string;
  link?: string;
  interactive?: boolean;
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export async function ticketEditCommand(ticketId?: string, options: TicketEditOptions = {}): Promise<void> {
  const isInteractive = options.interactive !== false;

  // Get ticket ID
  let resolvedId = ticketId;
  if (!resolvedId) {
    if (!isInteractive) {
      showError('Ticket ID is required in non-interactive mode');
      exitWithCode(EXIT_ERROR);
    }

    const selected = await selectTicket('Select ticket to edit:');
    if (!selected) {
      return;
    }
    resolvedId = selected;
  }

  // Fetch existing ticket
  let ticket;
  try {
    ticket = await getTicket(resolvedId);
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${resolvedId}`);
      if (!isInteractive) exitWithCode(EXIT_ERROR);
      return;
    }
    throw err;
  }

  let newTitle: string | undefined;
  let newDescription: string | undefined;
  let newLink: string | undefined;
  let newExternalId: string | undefined;

  if (isInteractive) {
    // Show current ticket info
    console.log(`\n  Editing: ${formatTicketDisplay(ticket)}`);
    console.log(muted(`  Project: ${ticket.projectName} (read-only)\n`));

    // Prompt for each field with current value as default
    newTitle = await input({
      message: `${icons.ticket} Title:`,
      default: ticket.title,
      validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
    });

    newDescription = await multilineInput({
      message: 'Description:',
      default: ticket.description,
    });

    newExternalId = await input({
      message: `${icons.info} External ID (e.g., JIRA-123):`,
      default: ticket.externalId ?? '',
    });

    newLink = await input({
      message: `${icons.info} Link:`,
      default: ticket.link ?? '',
      validate: (v) => {
        if (!v) return true;
        return validateUrl(v) ? true : 'Invalid URL format';
      },
    });

    // Trim and normalize empty values
    newTitle = newTitle.trim();
    newDescription = newDescription.trim() || undefined;
    newExternalId = newExternalId.trim() || undefined;
    newLink = newLink.trim() || undefined;
  } else {
    // Non-interactive mode: use provided options
    if (options.title !== undefined) {
      const trimmed = options.title.trim();
      if (trimmed.length === 0) {
        showError('--title cannot be empty');
        exitWithCode(EXIT_ERROR);
      }
      newTitle = trimmed;
    }

    if (options.description !== undefined) {
      newDescription = options.description.trim() || undefined;
    }

    if (options.externalId !== undefined) {
      newExternalId = options.externalId.trim() || undefined;
    }

    if (options.link !== undefined) {
      const trimmed = options.link.trim();
      if (trimmed && !validateUrl(trimmed)) {
        showError('--link must be a valid URL');
        exitWithCode(EXIT_ERROR);
      }
      newLink = trimmed || undefined;
    }

    // Check if any updates were provided
    if (
      newTitle === undefined &&
      newDescription === undefined &&
      newExternalId === undefined &&
      newLink === undefined
    ) {
      showError('No updates provided. Use --title, --description, --link, or --id.');
      exitWithCode(EXIT_ERROR);
    }
  }

  // Build updates object (only include changed fields)
  const updates: { title?: string; description?: string; link?: string; externalId?: string } = {};

  if (newTitle !== undefined && newTitle !== ticket.title) {
    updates.title = newTitle;
  }
  if (newDescription !== undefined && newDescription !== ticket.description) {
    updates.description = newDescription;
  }
  if (newLink !== undefined && newLink !== ticket.link) {
    updates.link = newLink;
  }
  if (newExternalId !== undefined && newExternalId !== ticket.externalId) {
    updates.externalId = newExternalId;
  }

  // Check if anything changed
  if (Object.keys(updates).length === 0) {
    console.log(muted('\n  No changes made.\n'));
    return;
  }

  try {
    const updated = await updateTicket(ticket.id, updates);

    showSuccess('Ticket updated!', [
      ['ID', updated.id],
      ['Title', updated.title],
      ['Project', updated.projectName],
    ]);

    if (updated.externalId) {
      console.log(field('External', updated.externalId));
    }
    if (updated.description) {
      console.log(fieldMultiline('Description', updated.description));
    }
    if (updated.link) {
      console.log(field('Link', updated.link));
    }
    console.log('');
  } catch (err) {
    if (err instanceof DuplicateTicketError) {
      showError(`Ticket with external ID "${newExternalId ?? ''}" already exists`);
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
    } else {
      throw err;
    }
    if (!isInteractive) exitWithCode(EXIT_ERROR);
  }
}
