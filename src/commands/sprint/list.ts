import { colors } from '@src/theme/index.ts';
import { listSprints } from '@src/store/sprint.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { badge, formatSprintStatus, icons, log, printHeader, showEmpty, showNextStep } from '@src/theme/ui.ts';

export async function sprintListCommand(): Promise<void> {
  const sprints = await listSprints();

  if (sprints.length === 0) {
    showEmpty('sprints', 'Create one with: ralphctl sprint create');
    return;
  }

  printHeader('Sprints', icons.sprint);

  const currentSprintId = await getCurrentSprint();

  const MARKER_W = 10; // '[current] ' = 10 visible chars
  const ID_W = Math.max(...sprints.map((s) => s.id.length), 4);
  const STATUS_W = 10; // emoji + space + longest status label

  for (const sprint of sprints) {
    const isCurrent = sprint.id === currentSprintId;
    const marker = isCurrent ? badge('current', 'success') + ' ' : ' '.repeat(MARKER_W);
    const id = colors.muted(sprint.id.padEnd(ID_W));
    const status = formatSprintStatus(sprint.status);
    const statusPad = ' '.repeat(Math.max(0, STATUS_W - sprint.status.length - 2));
    log.raw(`${marker}${id}  ${status}${statusPad}  ${sprint.name}`);
  }

  const hasActive = sprints.some((s) => s.status === 'active');
  if (!hasActive) {
    log.newline();
    showNextStep('ralphctl sprint start', 'start a sprint');
  }
  log.newline();
}
