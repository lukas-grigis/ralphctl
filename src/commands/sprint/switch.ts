import { setCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { selectSprint } from '@src/interactive/selectors.ts';
import { log, showSuccess } from '@src/theme/ui.ts';

/**
 * Quick sprint switcher for interactive mode
 */
export async function sprintSwitchCommand(): Promise<void> {
  const selectedId = await selectSprint('Select sprint to switch to:');
  if (!selectedId) return;

  await setCurrentSprint(selectedId);
  const sprint = await getSprint(selectedId);
  showSuccess('Switched to sprint!', [
    ['ID', sprint.id],
    ['Name', sprint.name],
  ]);
  log.newline();
}
