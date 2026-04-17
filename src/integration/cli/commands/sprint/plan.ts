import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { muted } from '@src/integration/ui/theme/theme.ts';
import {
  field,
  icons,
  log,
  printHeader,
  showError,
  showNextStep,
  showSuccess,
  showWarning,
  terminalBell,
} from '@src/integration/ui/theme/ui.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { providerDisplayName, resolveProvider } from '@src/integration/external/provider.ts';
import { getSharedDeps } from '@src/application/bootstrap.ts';
import { createPlanPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { renderParsedTasksTable } from './plan-utils.ts';

interface PlanOptions {
  auto: boolean;
  allPaths: boolean;
}

function parseArgs(args: string[]): { sprintId?: string; options: PlanOptions } {
  const options: PlanOptions = {
    auto: false,
    allPaths: false,
  };
  let sprintId: string | undefined;

  for (const arg of args) {
    if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '--all-paths') {
      options.allPaths = true;
    } else if (!arg.startsWith('-')) {
      sprintId = arg;
    }
  }

  return { sprintId, options };
}

export async function sprintPlanCommand(args: string[]): Promise<void> {
  const { sprintId, options } = parseArgs(args);

  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    showWarning('No sprint specified and no current sprint set.');
    showNextStep('ralphctl sprint create', 'create a new sprint');
    log.newline();
    return;
  }
  const id = idR.value;

  // Show header
  const sprint = await getSprint(id);
  const providerName = providerDisplayName(await resolveProvider());
  const modeLabel = options.auto ? 'Auto (headless)' : 'Interactive';

  printHeader('Sprint Planning', icons.sprint);
  console.log(field('Sprint', sprint.name));
  console.log(field('ID', sprint.id));
  console.log(field('Tickets', String(sprint.tickets.length)));
  console.log(field('Mode', modeLabel));
  console.log(field('Provider', providerName));
  log.newline();

  // Execute the plan pipeline (load-sprint → assert-draft → assert-all-approved
  // → run-plan → reorder-dependencies). Pipeline owns orchestration; this
  // command just renders the result.
  const shared = getSharedDeps();
  const pipeline = createPlanPipeline(shared, { auto: options.auto, allPaths: options.allPaths });
  const result = await executePipeline(pipeline, { sprintId: id });

  if (!result.ok) {
    showError(result.error.message);
    log.newline();
    return;
  }

  const summary = result.value.context.planSummary;
  if (!summary) {
    showError('Planning completed without producing a summary.');
    log.newline();
    return;
  }

  if (summary.importedCount === 0 && summary.totalGenerated === 0) {
    // User cancelled re-plan or no tasks generated
    log.dim('Cancelled.');
    log.newline();
    return;
  }

  // Show imported tasks
  const tasks = await listTasks(id);
  if (tasks.length > 0) {
    showSuccess(`Imported ${String(summary.importedCount)}/${String(summary.totalGenerated)} tasks.`);
    log.newline();
    console.log(
      renderParsedTasksTable(
        tasks.map((t) => ({
          name: t.name,
          description: t.description,
          steps: t.steps,
          verificationCriteria: t.verificationCriteria,
          repoId: t.repoId,
          ticketId: t.ticketId,
          blockedBy: t.blockedBy,
        }))
      )
    );
    console.log('');
  }

  if (summary.isReplan) {
    console.log(muted('Re-plan: previous tasks replaced.'));
  }
  log.dim('Tasks reordered by dependencies.');

  terminalBell();
  showNextStep('ralphctl sprint start', 'start executing tasks');
  log.newline();
}
