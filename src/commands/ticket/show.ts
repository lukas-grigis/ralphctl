import { muted } from '@src/theme/index.ts';
import { getTicket, TicketNotFoundError } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { selectTicket } from '@src/interactive/selectors.ts';
import { badge, DETAIL_LABEL_WIDTH, field, icons, log, renderCard, showError, showNextStep } from '@src/theme/ui.ts';

function labelValue(label: string, value: string): string {
  return field(label, value, DETAIL_LABEL_WIDTH).trimStart();
}

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

    // Ticket info card
    const infoLines: string[] = [labelValue('ID', ticket.id)];
    if (ticket.externalId) {
      infoLines.push(labelValue('External ID', ticket.externalId));
    }
    infoLines.push(labelValue('Project', ticket.projectName));
    infoLines.push(labelValue('Requirements', reqBadge));

    if (ticket.link) {
      infoLines.push(labelValue('Link', ticket.link));
    }

    // Repositories
    try {
      const project = await getProject(ticket.projectName);
      infoLines.push('');
      for (const repo of project.repositories) {
        infoLines.push(`  ${icons.bullet} ${repo.name} ${muted('→')} ${muted(repo.path)}`);
      }
    } catch {
      infoLines.push(labelValue('Repositories', muted('(project not found)')));
    }

    log.newline();
    console.log(renderCard(`${icons.ticket} ${ticket.title}`, infoLines));

    // Description card (if present)
    if (ticket.description) {
      log.newline();
      const descLines: string[] = [];
      for (const line of ticket.description.split('\n')) {
        descLines.push(line);
      }
      console.log(renderCard(`${icons.edit} Description`, descLines));
    }

    // Affected repositories card (if set from planning)
    if (ticket.affectedRepositories && ticket.affectedRepositories.length > 0) {
      log.newline();
      const affectedLines: string[] = [];
      for (const repoPath of ticket.affectedRepositories) {
        affectedLines.push(`${icons.bullet} ${repoPath}`);
      }
      console.log(renderCard(`${icons.project} Affected Repositories`, affectedLines));
    }

    log.newline();
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${ticketId}`);
      showNextStep('ralphctl ticket list', 'see available tickets');
      log.newline();
    } else {
      throw err;
    }
  }
}
