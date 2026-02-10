import { colors, muted, success } from '@src/theme/index.ts';
import { formatTicketDisplay, groupTicketsByProject, listTickets } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { badge, icons, log, printHeader, showEmpty } from '@src/theme/ui.ts';

export async function ticketListCommand(args: string[]): Promise<void> {
  const brief = args.includes('-b') || args.includes('--brief');
  const tickets = await listTickets();

  if (tickets.length === 0) {
    showEmpty('tickets', 'Add one with: ralphctl ticket add --project <project-name>');
    return;
  }

  if (brief) {
    // Brief mode: one line per ticket (markdown for LLM readability)
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

  // Interactive list grouped by project
  const ticketsByProject = groupTicketsByProject(tickets);

  printHeader(`Tickets (${String(tickets.length)})`, icons.ticket);

  for (const [projectName, projectTickets] of ticketsByProject) {
    // Project group header
    log.raw(`${colors.info(icons.project)} ${colors.info(projectName)}`);

    // Show project repos
    try {
      const project = await getProject(projectName);
      for (const repo of project.repositories) {
        log.raw(`    ${muted(repo.name)} ${muted('→')} ${muted(repo.path)}`, 1);
      }
    } catch {
      log.raw(`    ${muted('(project not found)')}`, 1);
    }
    log.newline();

    for (const ticket of projectTickets) {
      const reqBadge =
        ticket.requirementStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'muted');
      log.raw(`  ${icons.bullet} ${formatTicketDisplay(ticket)} ${reqBadge}`);
      if (ticket.description) {
        const preview = ticket.description.split('\n')[0] ?? '';
        const truncated = preview.length > 60 ? preview.slice(0, 57) + '...' : preview;
        log.raw(`      ${muted(truncated)}`, 1);
      }
    }
    log.newline();
  }

  // Summary
  const approved = tickets.filter((t) => t.requirementStatus === 'approved').length;
  log.dim(
    `Requirements: ${success(`${String(approved)} approved`)} / ${muted(`${String(tickets.length - approved)} pending`)}`
  );
  log.dim(`Showing ${String(tickets.length)} ticket(s)`);
  log.newline();
}
