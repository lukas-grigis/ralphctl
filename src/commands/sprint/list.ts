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

export async function sprintListCommand(): Promise<void> {
  const sprints = await listSprints();

  if (sprints.length === 0) {
    showEmpty('sprints', 'Create one with: ralphctl sprint create');
    return;
  }

  printHeader('Sprints', icons.sprint);

  const currentSprintId = await getCurrentSprint();

  const rows: string[][] = sprints.map((sprint) => {
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
  log.dim(`Showing ${String(sprints.length)} sprint(s)`);

  const hasActive = sprints.some((s) => s.status === 'active');
  if (!hasActive) {
    log.newline();
    showNextStep('ralphctl sprint start', 'start a sprint');
  }
  log.newline();
}
