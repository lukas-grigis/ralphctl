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

  const ID_W = Math.max(...sprints.map((s) => s.id.length), 4);
  const NAME_W = Math.max(...sprints.map((s) => s.name.length), 4);

  for (const sprint of sprints) {
    const isCurrent = sprint.id === currentSprintId;
    const marker = isCurrent ? badge('current', 'success') + ' ' : '  ';
    const status = formatSprintStatus(sprint.status);
    const id = colors.muted(sprint.id.padEnd(ID_W));
    const name = sprint.name.padEnd(NAME_W);
    log.raw(`${marker}${id}  ${status}  ${name}`);
  }

  const hasActive = sprints.some((s) => s.status === 'active');
  if (!hasActive) {
    log.newline();
    showNextStep('ralphctl sprint start', 'start a sprint');
  }
  log.newline();
}
