import { colors, muted, success } from '@src/theme/index.ts';
import { formatTicketDisplay, groupTicketsByProject, listTickets } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { RequirementStatusSchema } from '@src/schemas/index.ts';
import { badge, icons, log, printHeader, showEmpty, showError } from '@src/theme/ui.ts';

interface TicketListFilters {
  brief: boolean;
  projectFilter?: string;
  statusFilter?: string;
}

function parseListArgs(args: string[]): TicketListFilters {
  const result: TicketListFilters = {
    brief: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '-b' || arg === '--brief') result.brief = true;
    else if (arg === '--project' && next) {
      result.projectFilter = next;
      i++;
    } else if (arg === '--status' && next) {
      result.statusFilter = next;
      i++;
    }
  }
  return result;
}

function buildFilterSummary(filters: TicketListFilters): string {
  const parts: string[] = [];
  if (filters.projectFilter) parts.push(`project=${filters.projectFilter}`);
  if (filters.statusFilter) parts.push(`status=${filters.statusFilter}`);
  return parts.length > 0 ? ` (filtered: ${parts.join(', ')})` : '';
}

export async function ticketListCommand(args: string[]): Promise<void> {
  const { brief, projectFilter, statusFilter } = parseListArgs(args);

  // Validate status filter
  if (statusFilter) {
    const result = RequirementStatusSchema.safeParse(statusFilter);
    if (!result.success) {
      showError(`Invalid status: "${statusFilter}". Valid values: pending, approved`);
      return;
    }
  }

  const tickets = await listTickets();

  if (tickets.length === 0) {
    showEmpty('tickets', 'Add one with: ralphctl ticket add --project <project-name>');
    return;
  }

  // Apply filters
  let filtered = tickets;
  if (projectFilter) filtered = filtered.filter((t) => t.projectName === projectFilter);
  if (statusFilter) filtered = filtered.filter((t) => t.requirementStatus === statusFilter);

  const filterStr = buildFilterSummary({ brief, projectFilter, statusFilter });
  const isFiltered = filtered.length !== tickets.length;

  if (filtered.length === 0) {
    showEmpty('matching tickets', 'Try adjusting your filters');
    return;
  }

  if (brief) {
    // Brief mode: one line per ticket (markdown for LLM readability)
    const countLabel = isFiltered ? `${String(filtered.length)} of ${String(tickets.length)}` : String(tickets.length);
    console.log(`\n# Tickets (${countLabel})${filterStr}\n`);
    for (const ticket of filtered) {
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
  const ticketsByProject = groupTicketsByProject(filtered);

  printHeader(`Tickets (${String(filtered.length)})`, icons.ticket);

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
