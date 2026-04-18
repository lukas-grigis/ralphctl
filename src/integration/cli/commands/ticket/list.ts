import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { colors, muted, success } from '@src/integration/ui/theme/theme.ts';
import { formatTicketDisplay, listTickets } from '@src/integration/persistence/ticket.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { RequirementStatusSchema } from '@src/domain/models.ts';
import { badge, icons, log, printHeader, showEmpty, showError } from '@src/integration/ui/theme/ui.ts';
import { truncate } from '@src/domain/strings.ts';

interface TicketListFilters {
  brief: boolean;
  statusFilter?: string;
}

function parseListArgs(args: string[]): TicketListFilters {
  const result: TicketListFilters = { brief: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '-b' || arg === '--brief') result.brief = true;
    else if (arg === '--status' && next) {
      result.statusFilter = next;
      i++;
    }
  }
  return result;
}

function buildFilterSummary(filters: TicketListFilters): string {
  const parts: string[] = [];
  if (filters.statusFilter) parts.push(`status=${filters.statusFilter}`);
  return parts.length > 0 ? ` (filtered: ${parts.join(', ')})` : '';
}

export async function ticketListCommand(args: string[]): Promise<void> {
  const { brief, statusFilter } = parseListArgs(args);

  if (statusFilter) {
    const result = RequirementStatusSchema.safeParse(statusFilter);
    if (!result.success) {
      showError(`Invalid status: "${statusFilter}". Valid values: pending, approved`);
      return;
    }
  }

  const tickets = await listTickets();

  if (tickets.length === 0) {
    showEmpty('tickets', 'Add one with: ralphctl ticket add');
    return;
  }

  let filtered = tickets;
  if (statusFilter) filtered = filtered.filter((t) => t.requirementStatus === statusFilter);

  const filterStr = buildFilterSummary({ brief, statusFilter });
  const isFiltered = filtered.length !== tickets.length;

  if (filtered.length === 0) {
    showEmpty('matching tickets', 'Try adjusting your filters');
    return;
  }

  // Resolve sprint's project (all tickets in a sprint share it).
  const sprintR = await wrapAsync(() => getCurrentSprintOrThrow(), ensureError);
  const projectR = sprintR.ok ? await wrapAsync(() => getProjectById(sprintR.value.projectId), ensureError) : null;
  const projectLabel = projectR?.ok ? `${projectR.value.displayName} (${projectR.value.name})` : 'unknown';

  if (brief) {
    const countLabel = isFiltered ? `${String(filtered.length)} of ${String(tickets.length)}` : String(tickets.length);
    console.log(`\n# Tickets (${countLabel})${filterStr}\n`);
    for (const ticket of filtered) {
      const display = `[${ticket.id}] ${ticket.title}`;
      const reqBadge = ticket.requirementStatus === 'approved' ? ' [approved]' : ' [pending]';
      console.log(`- ${display}${reqBadge}`);
    }
    console.log('');
    return;
  }

  printHeader(`Tickets (${String(filtered.length)})`, icons.ticket);
  log.raw(`${colors.info(icons.project)} ${colors.info(projectLabel)}`);

  if (projectR?.ok) {
    for (const repo of projectR.value.repositories) {
      log.raw(`    ${muted(repo.name)} ${muted('→')} ${muted(repo.path)}`, 1);
    }
  }
  log.newline();

  for (const ticket of filtered) {
    const reqBadge = ticket.requirementStatus === 'approved' ? badge('approved', 'success') : badge('pending', 'muted');
    log.raw(`  ${icons.bullet} ${formatTicketDisplay(ticket)} ${reqBadge}`);
    if (ticket.description) {
      const preview = ticket.description.split('\n')[0] ?? '';
      const truncated = truncate(preview, 60);
      log.raw(`      ${muted(truncated)}`, 1);
    }
  }
  log.newline();

  const approved = filtered.filter((t) => t.requirementStatus === 'approved').length;
  log.dim(
    `Requirements: ${success(`${String(approved)} approved`)} / ${muted(`${String(filtered.length - approved)} pending`)}`
  );
  const showingLabel = isFiltered
    ? `Showing ${String(filtered.length)} of ${String(tickets.length)} ticket(s)${filterStr}`
    : `Showing ${String(tickets.length)} ticket(s)`;
  log.dim(showingLabel);
  log.newline();
}
