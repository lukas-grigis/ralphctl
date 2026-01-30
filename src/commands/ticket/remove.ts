import { confirm } from '@inquirer/prompts';
import { success, muted, error } from '@src/utils/colors.ts';
import { getTicket, removeTicket, TicketNotFoundError } from '@src/services/ticket.ts';

export async function ticketRemoveCommand(args: string[]): Promise<void> {
  const ticketId = args[0];

  if (!ticketId) {
    console.log(error('\nTicket ID required.'));
    console.log(muted('Usage: ralphctl ticket remove <ticket-id>\n'));
    return;
  }

  try {
    const ticket = await getTicket(ticketId);

    const confirmed = await confirm({
      message: `Remove ticket "${ticket.title}" (${ticket.id})?`,
      default: false,
    });

    if (!confirmed) {
      console.log(muted('\nTicket removal cancelled.\n'));
      return;
    }

    await removeTicket(ticketId);
    console.log(success(`\nTicket ${ticketId} removed successfully.\n`));
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      console.log(error(`\nTicket not found: ${ticketId}\n`));
    } else {
      throw err;
    }
  }
}
