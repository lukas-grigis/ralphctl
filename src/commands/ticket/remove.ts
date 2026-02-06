import { confirm } from '@inquirer/prompts';
import { muted } from '@src/theme/index.ts';
import { formatTicketDisplay, getTicket, removeTicket, TicketNotFoundError } from '@src/store/ticket.ts';
import { SprintStatusError } from '@src/store/sprint.ts';
import { selectTicket } from '@src/interactive/selectors.ts';
import { log, showError, showNextStep, showSuccess } from '@src/theme/ui.ts';

export async function ticketRemoveCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let ticketId = args.find((a) => !a.startsWith('-'));

  if (!ticketId) {
    const selected = await selectTicket('Select ticket to remove:');
    if (!selected) return;
    ticketId = selected;
  }

  try {
    const ticket = await getTicket(ticketId);

    if (!skipConfirm) {
      const confirmed = await confirm({
        message: `Remove ticket ${formatTicketDisplay(ticket)}?`,
        default: false,
      });

      if (!confirmed) {
        console.log(muted('\nTicket removal cancelled.\n'));
        return;
      }
    }

    await removeTicket(ticketId);
    showSuccess('Ticket removed', [['ID', ticketId]]);
    log.newline();
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${ticketId}`);
      showNextStep('ralphctl ticket list', 'see available tickets');
      log.newline();
    } else if (err instanceof SprintStatusError) {
      showError(err.message);
      log.newline();
    } else {
      throw err;
    }
  }
}
