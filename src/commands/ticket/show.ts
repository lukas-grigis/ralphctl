import { muted } from '@src/theme/index.ts';
import { getTicket, TicketNotFoundError } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { selectTicket } from '@src/interactive/selectors.ts';
import { badge, field, log, printHeader, showError } from '@src/theme/ui.ts';

export async function ticketShowCommand(args: string[]): Promise<void> {
  let ticketId = args[0];

  if (!ticketId) {
    const selected = await selectTicket('Select ticket to show:');
    if (!selected) return;
    ticketId = selected;
  }

  try {
    const ticket = await getTicket(ticketId);

    const reqBadge = ticket.requirementStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'muted');

    printHeader('Ticket Details');
    console.log(field('ID', ticket.id));
    if (ticket.externalId) {
      console.log(field('External', ticket.externalId));
    }
    console.log(field('Title', ticket.title));
    console.log(field('Project', ticket.projectName));
    console.log(field('Requirements', reqBadge));

    // Get project repositories
    try {
      const project = await getProject(ticket.projectName);
      console.log(field('Repositories', ''));
      for (const repo of project.repositories) {
        log.item(`${repo.name} → ${repo.path}`);
      }
    } catch {
      console.log(field('Repositories', muted('(project not found)')));
    }

    if (ticket.description) {
      log.newline();
      console.log(field('Description', ''));
      log.raw(ticket.description, 2);
    }

    if (ticket.link) {
      log.newline();
      console.log(field('Link', ticket.link));
    }

    log.newline();
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${ticketId}`);
      log.newline();
    } else {
      throw err;
    }
  }
}
