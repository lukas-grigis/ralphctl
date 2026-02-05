import { info, muted, warning } from '@src/theme/index.ts';
import { listSprints } from '@src/store/sprint.ts';
import { formatSprintStatus } from '@src/theme/ui.ts';

export async function sprintListCommand(): Promise<void> {
  const sprints = await listSprints();

  if (sprints.length === 0) {
    console.log(warning('\nNo sprints found.'));
    console.log(muted('Create one with: ralphctl sprint create\n'));
    return;
  }

  console.log(info('\nSprints:\n'));

  const hasActive = sprints.some((s) => s.status === 'active');

  for (const sprint of sprints) {
    const marker = sprint.status === 'active' ? ' *' : '  ';
    const status = formatSprintStatus(sprint.status);
    console.log(`${marker} ${sprint.id}  ${status}  ${sprint.name}`);
  }

  if (hasActive) {
    console.log(muted('\n  * = active sprint\n'));
  } else {
    console.log(muted('\nNo active sprint. Start with: ralphctl sprint start\n'));
  }
}
