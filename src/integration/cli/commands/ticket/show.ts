import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import { getTicket, TicketNotFoundError } from '@src/integration/persistence/ticket.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { selectTicket } from '@src/integration/cli/commands/shared/selectors.ts';
import { badge, icons, labelValue, log, renderCard, showError, showNextStep } from '@src/integration/ui/theme/ui.ts';

export async function ticketShowCommand(args: string[]): Promise<void> {
  let ticketId = args[0];

  if (!ticketId) {
    const selected = await selectTicket('Select ticket to show:');
    if (!selected) return;
    ticketId = selected;
  }

  const ticketR = await wrapAsync(() => getTicket(ticketId), ensureError);
  if (!ticketR.ok) {
    if (ticketR.error instanceof TicketNotFoundError) {
      showError(`Ticket not found: ${ticketId}`);
      showNextStep('ralphctl ticket list', 'see available tickets');
      log.newline();
    } else {
      throw ticketR.error;
    }
    return;
  }
  const ticket = ticketR.value;

  const reqBadge = ticket.requirementStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'muted');

  // Resolve project via current sprint (project is inherited).
  const sprintR = await wrapAsync(() => getCurrentSprintOrThrow(), ensureError);
  const projectR = sprintR.ok ? await wrapAsync(() => getProjectById(sprintR.value.projectId), ensureError) : null;

  const infoLines: string[] = [labelValue('ID', ticket.id)];
  infoLines.push(labelValue('Requirements', reqBadge));

  if (ticket.link) {
    infoLines.push(labelValue('Link', ticket.link));
  }

  if (projectR?.ok) {
    infoLines.push('');
    infoLines.push(labelValue('Project', `${projectR.value.displayName} (${projectR.value.name})`));
    for (const repo of projectR.value.repositories) {
      infoLines.push(`  ${icons.bullet} ${repo.name} ${muted('→')} ${muted(repo.path)}`);
    }
  }

  log.newline();
  console.log(renderCard(`${icons.ticket} ${ticket.title}`, infoLines));

  if (ticket.description) {
    log.newline();
    const descLines: string[] = [];
    for (const line of ticket.description.split('\n')) {
      descLines.push(line);
    }
    console.log(renderCard(`${icons.edit} Description`, descLines));
  }

  // Affected repos (from planning) — resolve ids to names for display.
  if (ticket.affectedRepoIds && ticket.affectedRepoIds.length > 0 && projectR?.ok) {
    log.newline();
    const affectedLines: string[] = [];
    const byId = new Map(projectR.value.repositories.map((r) => [r.id, r]));
    for (const repoId of ticket.affectedRepoIds) {
      const repo = byId.get(repoId);
      affectedLines.push(`${icons.bullet} ${repo ? `${repo.name} ${muted(`(${repo.path})`)}` : repoId}`);
    }
    console.log(renderCard(`${icons.project} Affected Repositories`, affectedLines));
  }

  log.newline();
}
