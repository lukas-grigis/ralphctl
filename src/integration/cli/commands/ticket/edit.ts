import { getPrompt } from '@src/application/bootstrap.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import { field, fieldMultiline, icons, showError, showNextStep, showSuccess } from '@src/integration/ui/theme/ui.ts';
import {
  formatTicketDisplay,
  getTicket,
  TicketNotFoundError,
  updateTicket,
} from '@src/integration/persistence/ticket.ts';
import { SprintStatusError } from '@src/integration/persistence/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/application/exit-codes.ts';
import { selectTicket } from '@src/integration/cli/commands/shared/selectors.ts';
import { editorInput } from '@src/integration/ui/prompts/editor-input.ts';

export interface TicketEditOptions {
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
  const ticketR = await wrapAsync(() => getTicket(resolvedId), ensureError);
  if (!ticketR.ok) {
    if (ticketR.error instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${resolvedId}`);
      showNextStep('ralphctl ticket list', 'see available tickets');
      if (!isInteractive) exitWithCode(EXIT_ERROR);
      return;
    }
    throw ticketR.error;
  }
  const ticket = ticketR.value;

  let newTitle: string | undefined;
  let newDescription: string | undefined;
  let newLink: string | undefined;

  if (isInteractive) {
    // Show current ticket info
    console.log(`\n  Editing: ${formatTicketDisplay(ticket)}\n`);

    // Prompt for each field with current value as default
    newTitle = await getPrompt().input({
      message: `${icons.ticket} Title:`,
      default: ticket.title,
      validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
    });

    const descR = await editorInput({
      message: 'Description:',
      default: ticket.description,
    });
    if (!descR.ok) {
      showError(`Editor input failed: ${descR.error.message}`);
      return;
    }
    newDescription = descR.value;

    newLink = await getPrompt().input({
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

    if (options.link !== undefined) {
      const trimmed = options.link.trim();
      if (trimmed && !validateUrl(trimmed)) {
        showError('--link must be a valid URL');
        exitWithCode(EXIT_ERROR);
      }
      newLink = trimmed || undefined;
    }

    // Check if any updates were provided
    if (newTitle === undefined && newDescription === undefined && newLink === undefined) {
      showError('No updates provided. Use --title, --description, or --link.');
      exitWithCode(EXIT_ERROR);
    }
  }

  // Build updates object (only include changed fields)
  const updates: { title?: string; description?: string; link?: string } = {};

  if (newTitle !== undefined && newTitle !== ticket.title) {
    updates.title = newTitle;
  }
  if (newDescription !== undefined && newDescription !== ticket.description) {
    updates.description = newDescription;
  }
  if (newLink !== undefined && newLink !== ticket.link) {
    updates.link = newLink;
  }

  // Check if anything changed
  if (Object.keys(updates).length === 0) {
    console.log(muted('\n  No changes made.\n'));
    return;
  }

  const updateR = await wrapAsync(() => updateTicket(ticket.id, updates), ensureError);
  if (!updateR.ok) {
    if (updateR.error instanceof SprintStatusError) {
      showError(updateR.error.message);
    } else {
      throw updateR.error;
    }
    if (!isInteractive) exitWithCode(EXIT_ERROR);
    return;
  }

  const updated = updateR.value;
  showSuccess('Ticket updated!', [
    ['ID', updated.id],
    ['Title', updated.title],
  ]);

  if (updated.description) {
    console.log(fieldMultiline('Description', updated.description));
  }
  if (updated.link) {
    console.log(field('Link', updated.link));
  }
  console.log('');
}
