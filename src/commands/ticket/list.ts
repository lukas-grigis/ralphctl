import { muted, success } from '@src/theme/index.ts';
import { formatTicketDisplay, groupTicketsByProject, listTickets } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { showEmpty } from '@src/theme/ui.ts';

export async function ticketListCommand(args: string[]): Promise<void> {
  const brief = args.includes('-b') || args.includes('--brief');
  const tickets = await listTickets();

  if (tickets.length === 0) {
    showEmpty('tickets', 'Add one with: ralphctl ticket add --project <project-name>');
    return;
  }

  if (brief) {
    // Brief mode: one line per ticket
    console.log(`\n# Tickets (${String(tickets.length)})\n`);
    for (const ticket of tickets) {
      const display = ticket.externalId
        ? `**${ticket.externalId}**: ${ticket.title}`
        : `[${ticket.id}] ${ticket.title}`;
      const reqBadge = ticket.requirementStatus === 'approved' ? ' [approved]' : ' [pending]';
      console.log(`- ${display}${reqBadge} (${ticket.projectName})`);
    }
    console.log('');
    return;
  }

  // Full markdown format grouped by project
  console.log(`\n# Tickets (${String(tickets.length)})\n`);

  const ticketsByProject = groupTicketsByProject(tickets);

  for (const [projectName, projectTickets] of ticketsByProject) {
    console.log(`## Project: ${projectName}\n`);

    // Get project repositories
    try {
      const project = await getProject(projectName);
      const repoPaths = project.repositories.map((r) => `${r.name} (${r.path})`);
      console.log(muted(`Repositories: ${repoPaths.join(', ')}\n`));
    } catch {
      console.log(muted('Repositories: (project not found)\n'));
    }

    for (const ticket of projectTickets) {
      const reqBadge = ticket.requirementStatus === 'approved' ? success(' [approved]') : muted(' [pending]');

      console.log(`### ${formatTicketDisplay(ticket)}${reqBadge}\n`);

      if (ticket.description) {
        console.log('**Description:**\n');
        console.log(ticket.description);
        console.log('');
      }

      if (ticket.link) {
        console.log('**Link:**\n');
        console.log(ticket.link);
        console.log('');
      }

      console.log('---\n');
    }
  }
}
