import { listSprints } from '@src/store/sprint.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import {
  badge,
  formatSprintStatus,
  icons,
  log,
  printHeader,
  renderTable,
  showEmpty,
  showNextStep,
} from '@src/theme/ui.ts';

export async function sprintListCommand(args: string[] = []): Promise<void> {
  // Parse status filter
  let statusFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) {
      statusFilter = args[i + 1];
      i++;
    }
  }

  const sprints = await listSprints();

  if (sprints.length === 0) {
    showEmpty('sprints', 'Create one with: ralphctl sprint create');
    return;
  }

  const filtered = statusFilter ? sprints.filter((s) => s.status === statusFilter) : sprints;
  const isFiltered = filtered.length !== sprints.length;
  const filterStr = statusFilter ? ` (filtered: status=${statusFilter})` : '';

  if (filtered.length === 0) {
    showEmpty('matching sprints', 'Try adjusting your filters');
    return;
  }

  printHeader('Sprints', icons.sprint);

  const currentSprintId = await getCurrentSprint();

  const rows: string[][] = filtered.map((sprint) => {
    const isCurrent = sprint.id === currentSprintId;
    const marker = isCurrent ? badge('current', 'success') : '';
    return [marker, sprint.id, formatSprintStatus(sprint.status), sprint.name, String(sprint.tickets.length)];
  });

  console.log(
    renderTable(
      [
        { header: '', minWidth: 0 },
        { header: 'ID' },
        { header: 'Status' },
        { header: 'Name' },
        { header: 'Tickets', align: 'right' },
      ],
      rows
    )
  );

  log.newline();
  const showingLabel = isFiltered
    ? `Showing ${String(filtered.length)} of ${String(sprints.length)} sprint(s)${filterStr}`
    : `Showing ${String(sprints.length)} sprint(s)`;
  log.dim(showingLabel);

  const hasActive = filtered.some((s) => s.status === 'active');
  if (!hasActive) {
    log.newline();
    showNextStep('ralphctl sprint start', 'start a sprint');
  }
  log.newline();
}
