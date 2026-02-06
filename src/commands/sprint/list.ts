import { listSprints } from '@src/store/sprint.ts';
import { formatSprintStatus, icons, log, printHeader, showEmpty, showNextStep } from '@src/theme/ui.ts';

export async function sprintListCommand(): Promise<void> {
  const sprints = await listSprints();

  if (sprints.length === 0) {
    showEmpty('sprints', 'Create one with: ralphctl sprint create');
    return;
  }

  printHeader('Sprints', icons.sprint);

  const hasActive = sprints.some((s) => s.status === 'active');

  for (const sprint of sprints) {
    const marker = sprint.status === 'active' ? icons.active : ' ';
    const status = formatSprintStatus(sprint.status);
    log.raw(`${marker} ${sprint.id}  ${status}  ${sprint.name}`);
  }

  if (hasActive) {
    log.dim(`${icons.active} = active sprint`);
  } else {
    log.newline();
    showNextStep('ralphctl sprint start', 'start a sprint');
  }
  log.newline();
}
