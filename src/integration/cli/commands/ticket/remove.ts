import { getPrompt } from '@src/integration/bootstrap.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import {
  formatTicketDisplay,
  getTicket,
  removeTicket,
  TicketNotFoundError,
} from '@src/integration/persistence/ticket.ts';
import { SprintStatusError } from '@src/integration/persistence/sprint.ts';
import { selectTicket } from '@src/integration/cli/commands/shared/selectors.ts';
import { log, showError, showNextStep, showSuccess } from '@src/integration/ui/theme/ui.ts';

export async function ticketRemoveCommand(args: string[]): Promise<void> {
  const skipConfirm = args.includes('-y') || args.includes('--yes');
  let ticketId = args.find((a) => !a.startsWith('-'));

  if (!ticketId) {
    const selected = await selectTicket('Select ticket to remove:');
    if (!selected) return;
    ticketId = selected;
  }

  const opR = await wrapAsync(async () => {
    const ticket = await getTicket(ticketId);

    if (!skipConfirm) {
      const confirmed = await getPrompt().confirm({
        message: `Remove ticket ${formatTicketDisplay(ticket)}?`,
        default: false,
      });

      if (!confirmed) {
        console.log(muted('\nTicket removal cancelled.\n'));
        return null;
      }
    }

    await removeTicket(ticketId);
    return ticket;
  }, ensureError);
  if (!opR.ok) {
    if (opR.error instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${ticketId}`);
      showNextStep('ralphctl ticket list', 'see available tickets');
      log.newline();
    } else if (opR.error instanceof SprintStatusError) {
      showError(opR.error.message);
      log.newline();
    } else {
      throw opR.error;
    }
    return;
  }

  if (opR.value !== null) {
    showSuccess('Ticket removed', [['ID', ticketId]]);
    log.newline();
  }
}
