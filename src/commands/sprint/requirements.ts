import { join } from 'node:path';
import { getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { getSprintDir } from '@src/utils/paths.ts';
import { exportRequirementsToMarkdown } from '@src/utils/requirements-export.ts';
import { field, icons, log, printHeader, showEmpty, showError, showSuccess, showWarning } from '@src/theme/ui.ts';
import { selectSprint } from '@src/interactive/selectors.ts';

export async function sprintRequirementsCommand(args: string[] = []): Promise<void> {
  const sprintId = args.find((a) => !a.startsWith('-'));

  let id: string;
  try {
    id = await resolveSprintId(sprintId);
  } catch {
    const selected = await selectSprint('Select sprint to export requirements from:');
    if (!selected) return;
    id = selected;
  }

  const sprint = await getSprint(id);

  if (sprint.tickets.length === 0) {
    showEmpty('tickets in this sprint', 'Add tickets first: ralphctl ticket add --project <name>');
    return;
  }

  const approvedTickets = sprint.tickets.filter((t) => t.requirementStatus === 'approved');
  if (approvedTickets.length === 0) {
    showWarning('No approved requirements to export.');
    log.dim('Refine requirements first: ralphctl sprint refine');
    log.newline();
    return;
  }

  printHeader('Export Requirements', icons.sprint);
  console.log(field('Sprint', sprint.name));
  console.log(field('Tickets', `${String(sprint.tickets.length)} total, ${String(approvedTickets.length)} approved`));
  log.newline();

  // Export to sprint directory
  const sprintDir = getSprintDir(id);
  const outputPath = join(sprintDir, 'requirements.md');

  try {
    await exportRequirementsToMarkdown(sprint, outputPath);
    showSuccess('Requirements written to:');
    log.item(outputPath);
  } catch (err) {
    if (err instanceof Error) {
      showError(`Failed to write requirements: ${err.message}`);
    } else {
      showError('Failed to write requirements: Unknown error');
    }
    return;
  }

  log.newline();
}
