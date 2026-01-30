import { info, muted, warning, highlight } from '@src/utils/colors.ts';
import { listTickets } from '@src/services/ticket.ts';

export async function ticketListCommand(args: string[]): Promise<void> {
  const verbose = args.includes('-v') || args.includes('--verbose');
  const tickets = await listTickets();

  if (tickets.length === 0) {
    console.log(warning('\nNo tickets found in the active scope.'));
    console.log(muted('Add one with: ralphctl ticket add\n'));
    return;
  }

  console.log(info(`\nTickets (${String(tickets.length)}):\n`));

  for (const ticket of tickets) {
    console.log(highlight(`  ${ticket.id}`) + `: ${ticket.title}`);
    if (ticket.description) {
      if (verbose) {
        console.log(muted('    Description:'));
        const lines = ticket.description.split('\n');
        for (const line of lines) {
          console.log(muted(`      ${line}`));
        }
      } else {
        // Show truncated description
        const desc =
          ticket.description.length > 80
            ? ticket.description.substring(0, 77) + '...'
            : ticket.description;
        console.log(muted(`    ${desc}`));
      }
    }
    if (ticket.link) {
      console.log(muted(`    ${ticket.link}`));
    }
    if (verbose) {
      console.log('');
    }
  }

  if (!verbose && tickets.some((t) => t.description && t.description.length > 80)) {
    console.log(muted('\n  Use -v for full descriptions'));
  }

  console.log('');
}
