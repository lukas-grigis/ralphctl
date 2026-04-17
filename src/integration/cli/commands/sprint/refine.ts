import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import {
  field,
  icons,
  log,
  printHeader,
  printSeparator,
  showError,
  showSuccess,
  showTip,
  showWarning,
} from '@src/integration/ui/theme/ui.ts';
import { resolveSprintId, getSprint } from '@src/integration/persistence/sprint.ts';
import { getSharedDeps } from '@src/application/bootstrap.ts';
import { createRefineUseCase } from '@src/application/factories.ts';

interface RefineOptions {
  project?: string;
}

function parseArgs(args: string[]): { sprintId?: string; options: RefineOptions } {
  const options: RefineOptions = {};
  let sprintId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--project') {
      options.project = nextArg;
      i++;
    } else if (!arg?.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

export async function sprintRefineCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showTip('Specify a sprint ID or create one first.');
    log.newline();
    return;
  }
  const id = idR.value;

  // Show header
  const sprint = await getSprint(id);
  printHeader('Requirements Refinement', icons.ticket);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  log.newline();

  // Execute use case
  const shared = getSharedDeps();
  const useCase = createRefineUseCase(shared);
  const result = await useCase.execute(id, { project: options.project });

  if (!result.ok) {
    showError(result.error.message);
    log.newline();
    return;
  }

  const summary = result.value;

  // Display summary
  printSeparator(60);
  log.newline();
  printHeader('Summary', icons.success);
  console.log(field('Approved', String(summary.approved)));
  console.log(field('Skipped', String(summary.skipped)));
  console.log(field('Total', String(summary.total)));
  log.newline();

  if (summary.allApproved) {
    showSuccess('All requirements approved!');
    showTip('Run "ralphctl sprint plan" to generate tasks.');
  } else if (summary.total === 0) {
    showSuccess('All tickets already have approved requirements!');
    showTip('Run "ralphctl sprint plan" to generate tasks.');
  } else {
    log.info(`${String(summary.total - summary.approved)} ticket(s) still pending.`);
    showTip('Continue refinement with: ralphctl sprint refine');
  }
  log.newline();
}
