import { info, muted, error } from '@src/utils/colors.ts';
import { getTicket, TicketNotFoundError } from '@src/services/ticket.ts';

export async function ticketShowCommand(args: string[]): Promise<void> {
  const ticketId = args[0];

  if (!ticketId) {
    console.log(error('\nTicket ID required.'));
    console.log(muted('Usage: ralphctl ticket show <ticket-id>\n'));
    return;
  }

  try {
    const ticket = await getTicket(ticketId);

    console.log(info('\nTicket Details:\n'));
    console.log(info('  ID:    ') + ticket.id);
    console.log(info('  Title: ') + ticket.title);

    if (ticket.description) {
      console.log(info('\n  Description:'));
      console.log('    ' + ticket.description);
    }

    if (ticket.link) {
      console.log(info('\n  Link: ') + ticket.link);
    }

    console.log('');
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      console.log(error(`\nTicket not found: ${ticketId}\n`));
    } else {
      throw err;
    }
  }
}
