import { confirm } from '@inquirer/prompts';
import { colors } from '@src/theme/index.ts';
import {
  emoji,
  icons,
  log,
  printHeader,
  printSeparator,
  progressBar,
  showSuccess,
  showWarning,
} from '@src/theme/ui.ts';
import { sprintCreateCommand } from '@src/commands/sprint/create.ts';
import { addSingleTicketInteractive } from '@src/commands/ticket/add.ts';
import { sprintRefineCommand } from '@src/commands/sprint/refine.ts';
import { sprintPlanCommand } from '@src/commands/sprint/plan.ts';
import { sprintStartCommand } from '@src/commands/sprint/start.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';

const TOTAL_STEPS = 5;

/**
 * Display a step progress indicator with a progress bar.
 */
function showStepProgress(step: number, title: string): void {
  const bar = progressBar(step - 1, TOTAL_STEPS, { width: 10, showPercent: false });
  log.newline();
  printSeparator();
  console.log(`  ${colors.highlight(`Step ${String(step)} of ${String(TOTAL_STEPS)}`)}  ${bar}  ${title}`);
  log.newline();
}

/**
 * Run the sprint setup wizard -- a multi-step guided flow that walks the user
 * through creating a sprint, adding tickets, refining, planning, and starting.
 */
export async function runWizard(): Promise<void> {
  const r = await wrapAsync(async () => {
    printHeader('Sprint Setup Wizard', emoji.donut);
    log.dim('This wizard will guide you through setting up a new sprint.');
    log.dim('You can skip optional steps along the way.');
    log.newline();

    // ── Step 1: Create Sprint ──────────────────────────────────────────────
    showStepProgress(1, 'Create Sprint');

    const createResult = await wrapAsync(() => sprintCreateCommand({ interactive: true }), ensureError);
    if (!createResult.ok) {
      log.error(`Sprint creation failed: ${createResult.error.message}`);
      log.newline();
      showWarning('Cannot continue without a sprint. Wizard aborted.');
      return;
    }

    const sprintId = await getCurrentSprint();
    if (!sprintId) {
      showWarning('No current sprint set. Wizard aborted.');
      return;
    }

    // ── Step 2: Add Tickets ────────────────────────────────────────────────
    showStepProgress(2, 'Add Tickets');

    let ticketCount = 0;
    let addMore = true;

    while (addMore) {
      const ticketResult = await wrapAsync(() => addSingleTicketInteractive({}), ensureError);

      if (ticketResult.ok) {
        if (ticketResult.value) {
          ticketCount++;
        } else {
          // No ticket created (no projects, or unrecoverable error) — exit loop
          break;
        }
      } else {
        log.error(`Failed to add ticket: ${ticketResult.error.message}`);
      }

      log.newline();
      addMore = await confirm({
        message: `${emoji.donut} Add another ticket?`,
        default: true,
      });
    }

    if (ticketCount === 0) {
      log.newline();
      showWarning('No tickets added. You can add them later with: ralphctl ticket add');
    }

    // ── Step 3: Refine Requirements ────────────────────────────────────────
    showStepProgress(3, 'Refine Requirements');

    if (ticketCount === 0) {
      log.dim('Skipped -- no tickets to refine.');
    } else {
      const shouldRefine = await confirm({
        message: `${emoji.donut} Refine requirements now?`,
        default: true,
      });

      if (shouldRefine) {
        const refineResult = await wrapAsync(() => sprintRefineCommand([]), ensureError);
        if (!refineResult.ok) {
          log.error(`Refinement failed: ${refineResult.error.message}`);
          log.dim('You can refine later with: ralphctl sprint refine');
        }
      } else {
        log.dim('Skipped. You can refine later with: ralphctl sprint refine');
      }
    }

    // ── Step 4: Plan Tasks ─────────────────────────────────────────────────
    showStepProgress(4, 'Plan Tasks');

    // Check if refinement was completed (all requirements approved)
    let canPlan = false;
    const sprintCheckResult = await wrapAsync(() => getSprint(sprintId), ensureError);
    if (sprintCheckResult.ok) {
      const sprint = sprintCheckResult.value;
      const hasTickets = sprint.tickets.length > 0;
      const allApproved = hasTickets && sprint.tickets.every((t) => t.requirementStatus === 'approved');
      canPlan = allApproved;

      if (!hasTickets) {
        log.dim('Skipped -- no tickets to plan.');
      } else if (!allApproved) {
        log.dim('Skipped -- not all requirements are approved yet.');
        log.dim('Refine first with: ralphctl sprint refine');
      }
    } else {
      log.dim('Skipped -- could not read sprint state.');
    }

    if (canPlan) {
      const shouldPlan = await confirm({
        message: `${emoji.donut} Generate tasks now?`,
        default: true,
      });

      if (shouldPlan) {
        const planResult = await wrapAsync(() => sprintPlanCommand([]), ensureError);
        if (!planResult.ok) {
          log.error(`Planning failed: ${planResult.error.message}`);
          log.dim('You can plan later with: ralphctl sprint plan');
        }
      } else {
        log.dim('Skipped. You can plan later with: ralphctl sprint plan');
      }
    }

    // ── Step 5: Start Execution ────────────────────────────────────────────
    showStepProgress(5, 'Start Execution');

    const shouldStart = await confirm({
      message: `${emoji.donut} Start execution now?`,
      default: false,
    });

    if (shouldStart) {
      const startResult = await wrapAsync(
        // Note: sprintStartCommand may call process.exit() on completion
        () => sprintStartCommand([]),
        ensureError
      );
      if (!startResult.ok) {
        log.error(`Execution failed: ${startResult.error.message}`);
      }
      return;
    }

    // ── Completion Summary ─────────────────────────────────────────────────
    log.newline();
    printSeparator();
    showSuccess('Wizard complete!');
    log.newline();

    const summaryResult = await wrapAsync(() => getSprint(sprintId), ensureError);
    if (summaryResult.ok) {
      const sprint = summaryResult.value;
      log.info(`Sprint "${sprint.name}" is ready.`);
      log.item(`${icons.ticket}  ${String(sprint.tickets.length)} ticket(s)`);

      const approvedCount = sprint.tickets.filter((t) => t.requirementStatus === 'approved').length;
      if (sprint.tickets.length > 0) {
        log.item(`${icons.success}  ${String(approvedCount)}/${String(sprint.tickets.length)} requirements approved`);
      }
    }
    // Sprint read failed — skip summary details

    log.newline();
    log.dim('Next steps:');
    if (ticketCount === 0) {
      log.item('ralphctl ticket add --project <name>');
    }
    log.item('ralphctl sprint refine');
    log.item('ralphctl sprint plan');
    log.item('ralphctl sprint start');
    log.newline();
  }, ensureError);

  if (!r.ok) {
    if (r.error.name === 'ExitPromptError') {
      log.newline();
      showWarning('Wizard cancelled');
      log.newline();
      return;
    }
    throw r.error;
  }
}
