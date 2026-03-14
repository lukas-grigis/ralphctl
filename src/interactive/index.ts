import { clearScreen, emoji, log, printSeparator, showBanner } from '@src/theme/ui.ts';
import { colors, getQuoteForContext } from '@src/theme/index.ts';
import { buildMainMenu, buildSubMenu, isWorkflowAction, type MenuContext, type MenuItem } from './menu.ts';
import { renderStatusHeader } from './dashboard.ts';
import { getAiProvider, getConfig } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { listProjects } from '@src/store/project.ts';
import { getNextAction, type DashboardData } from './dashboard.ts';
import { allRequirementsApproved, getPendingRequirements } from '@src/store/ticket.ts';
import { type Tasks, TasksSchema } from '@src/schemas/index.ts';
import { getTasksFilePath } from '@src/utils/paths.ts';
import { readValidatedJson } from '@src/utils/storage.ts';
import { select } from '@inquirer/prompts';
import { escapableSelect } from './escapable.ts';
import { wrapAsync } from '@src/utils/result-helpers.ts';

// Command imports - project
import { projectAddCommand } from '@src/commands/project/add.ts';
import { projectListCommand } from '@src/commands/project/list.ts';
import { projectShowCommand } from '@src/commands/project/show.ts';
import { projectRemoveCommand } from '@src/commands/project/remove.ts';
import { projectRepoAddCommand, projectRepoRemoveCommand } from '@src/commands/project/repo.ts';

// Command imports - sprint
import { sprintCreateCommand } from '@src/commands/sprint/create.ts';
import { sprintListCommand } from '@src/commands/sprint/list.ts';
import { sprintShowCommand } from '@src/commands/sprint/show.ts';
import { sprintContextCommand } from '@src/commands/sprint/context.ts';
import { sprintCurrentCommand } from '@src/commands/sprint/current.ts';
import { sprintRefineCommand } from '@src/commands/sprint/refine.ts';
import { sprintIdeateCommand } from '@src/commands/sprint/ideate.ts';
import { sprintPlanCommand } from '@src/commands/sprint/plan.ts';
import { sprintStartCommand } from '@src/commands/sprint/start.ts';
import { sprintCloseCommand } from '@src/commands/sprint/close.ts';
import { sprintDeleteCommand } from '@src/commands/sprint/delete.ts';
import { sprintRequirementsCommand } from '@src/commands/sprint/requirements.ts';
import { sprintHealthCommand } from '@src/commands/sprint/health.ts';

// Command imports - ticket
import { ticketAddCommand } from '@src/commands/ticket/add.ts';
import { ticketEditCommand } from '@src/commands/ticket/edit.ts';
import { ticketListCommand } from '@src/commands/ticket/list.ts';
import { ticketShowCommand } from '@src/commands/ticket/show.ts';
import { ticketRemoveCommand } from '@src/commands/ticket/remove.ts';
import { ticketRefineCommand } from '@src/commands/ticket/refine.ts';

// Command imports - task
import { taskAddCommand } from '@src/commands/task/add.ts';
import { taskImportCommand } from '@src/commands/task/import.ts';
import { taskListCommand } from '@src/commands/task/list.ts';
import { taskShowCommand } from '@src/commands/task/show.ts';
import { taskStatusCommand } from '@src/commands/task/status.ts';
import { taskNextCommand } from '@src/commands/task/next.ts';
import { taskReorderCommand } from '@src/commands/task/reorder.ts';
import { taskRemoveCommand } from '@src/commands/task/remove.ts';

// Command imports - progress
import { progressLogCommand } from '@src/commands/progress/log.ts';
import { progressShowCommand } from '@src/commands/progress/show.ts';

// Command imports - config
import { configShowCommand, configSetCommand } from '@src/commands/config/config.ts';

// Command imports - doctor
import { doctorCommand } from '@src/commands/doctor/doctor.ts';

// Custom theme with donut selector
const selectTheme = {
  icon: { cursor: emoji.donut },
  style: {
    highlight: (text: string) => colors.highlight(text),
    description: (text: string) => colors.muted(text),
  },
};

/**
 * Command dispatch map: (group, subCommand) → handler
 */
type CommandHandler = () => Promise<void>;

const commandMap: Record<string, Record<string, CommandHandler>> = {
  project: {
    add: () => projectAddCommand({ interactive: true }),
    list: () => projectListCommand(),
    show: () => projectShowCommand([]),
    remove: () => projectRemoveCommand([]),
    'repo add': () => projectRepoAddCommand([]),
    'repo remove': () => projectRepoRemoveCommand([]),
  },
  sprint: {
    create: () => sprintCreateCommand({ interactive: true }),
    list: () => sprintListCommand(),
    show: () => sprintShowCommand([]),
    context: () => sprintContextCommand([]),
    current: () => sprintCurrentCommand(['-']),
    refine: () => sprintRefineCommand([]),
    ideate: () => sprintIdeateCommand([]),
    plan: () => sprintPlanCommand([]),
    start: () => sprintStartCommand([]),
    requirements: () => sprintRequirementsCommand([]),
    health: () => sprintHealthCommand(),
    close: () => sprintCloseCommand([]),
    delete: () => sprintDeleteCommand([]),
    'progress show': () => progressShowCommand(),
    'progress log': () => progressLogCommand([]),
  },
  ticket: {
    add: () => ticketAddCommand({ interactive: true }),
    edit: () => ticketEditCommand(undefined, { interactive: true }),
    list: () => ticketListCommand([]),
    show: () => ticketShowCommand([]),
    refine: () => ticketRefineCommand(undefined, { interactive: true }),
    remove: () => ticketRemoveCommand([]),
  },
  task: {
    add: () => taskAddCommand({ interactive: true }),
    import: () => taskImportCommand([]),
    list: () => taskListCommand([]),
    show: () => taskShowCommand([]),
    status: () => taskStatusCommand([]),
    next: () => taskNextCommand(),
    reorder: () => taskReorderCommand([]),
    remove: () => taskRemoveCommand([]),
  },
  progress: {
    log: () => progressLogCommand([]),
    show: () => progressShowCommand(),
  },
  doctor: {
    run: () => doctorCommand(),
  },
  config: {
    show: () => configShowCommand(),
    'set provider': async () => {
      const choice = await select({
        message: `${emoji.donut} Which AI buddy should help with my homework?`,
        choices: [
          { name: 'Claude Code', value: 'claude' as const },
          { name: 'GitHub Copilot', value: 'copilot' as const },
        ],
        default: (await getAiProvider()) ?? undefined,
        theme: selectTheme,
      });
      await configSetCommand(['provider', choice]);
    },
  },
};

/**
 * Show themed farewell message on exit.
 */
function showFarewell(): void {
  const quote = getQuoteForContext('farewell');
  console.log('');
  printSeparator();
  console.log(`  ${emoji.donut}  ${colors.muted(quote)}`);
  console.log('');
}

/**
 * Pause until the user presses Enter so they can read command output
 * before the screen is cleared for the next menu render.
 */
async function pressEnterToContinue(): Promise<void> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question(colors.muted('  Press Enter to continue...'), () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Show the welcome banner with gradient styling.
 * Note: showBanner() already prints a Ralph quote.
 */
function showWelcomeBanner(): void {
  showBanner();
}

/**
 * Read tasks for a sprint, returning empty array if the file doesn't exist yet.
 */
async function readTasksSafe(sprintId: string): Promise<Tasks> {
  const result = await readValidatedJson(getTasksFilePath(sprintId), TasksSchema);
  if (!result.ok) return [];
  return result.value;
}

/**
 * Gather current application state for context-aware menus.
 * Reads each data file at most once and parallelizes independent reads.
 * Returns both MenuContext and optional DashboardData for status header.
 */
async function getMenuContext(): Promise<{ ctx: MenuContext; dashboardData: DashboardData | null }> {
  let dashboardData: DashboardData | null = null;

  const ctx: MenuContext = {
    hasProjects: false,
    projectCount: 0,
    currentSprintId: null,
    currentSprintName: null,
    currentSprintStatus: null,
    ticketCount: 0,
    taskCount: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    pendingRequirements: 0,
    allRequirementsApproved: false,
    plannedTicketCount: 0,
    nextAction: null,
    aiProvider: null,
  };

  // Read config and projects in parallel (independent files)
  const [config, projects] = await Promise.all([getConfig().catch(() => null), listProjects().catch(() => [])]);

  ctx.hasProjects = projects.length > 0;
  ctx.projectCount = projects.length;
  ctx.aiProvider = config?.aiProvider ?? null;

  const sprintId = config?.currentSprint ?? null;
  if (!sprintId) return { ctx, dashboardData };

  ctx.currentSprintId = sprintId;

  // Read sprint and tasks in parallel (both depend on sprintId, but not each other)
  const [sprint, tasks] = await Promise.all([getSprint(sprintId).catch(() => null), readTasksSafe(sprintId)]);

  if (!sprint) return { ctx, dashboardData };

  ctx.currentSprintName = sprint.name;
  ctx.currentSprintStatus = sprint.status;
  ctx.ticketCount = sprint.tickets.length;

  const pendingTickets = getPendingRequirements(sprint.tickets);
  ctx.pendingRequirements = pendingTickets.length;
  ctx.allRequirementsApproved = allRequirementsApproved(sprint.tickets);

  ctx.taskCount = tasks.length;
  ctx.tasksDone = tasks.filter((t) => t.status === 'done').length;
  ctx.tasksInProgress = tasks.filter((t) => t.status === 'in_progress').length;

  // Count tickets that have at least one associated task
  const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
  ctx.plannedTicketCount = sprint.tickets.filter((t) => ticketIdsWithTasks.has(t.id)).length;

  // Build DashboardData from already-loaded data (no extra I/O)
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const blockedCount = tasks.filter(
    (t) => t.status !== 'done' && t.blockedBy.length > 0 && !t.blockedBy.every((id) => doneIds.has(id))
  ).length;

  dashboardData = {
    sprint,
    tasks,
    approvedCount: sprint.tickets.length - pendingTickets.length,
    pendingCount: pendingTickets.length,
    blockedCount,
    plannedTicketCount: ctx.plannedTicketCount,
    aiProvider: ctx.aiProvider,
  };

  ctx.nextAction = getNextAction(dashboardData);

  return { ctx, dashboardData };
}

/**
 * Run the interactive REPL mode
 */
export async function interactiveMode(): Promise<void> {
  let escPressed = false;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    const { ctx, dashboardData } = await getMenuContext();

    // Clear and re-render banner + content each iteration
    clearScreen();
    showWelcomeBanner();

    // Persistent status header before main menu
    const statusLines = renderStatusHeader(dashboardData);
    if (statusLines.length > 0) {
      for (const line of statusLines) {
        console.log(line);
      }
      log.newline();
    }

    const { items: mainMenu, defaultValue } = buildMainMenu(ctx);

    // ESC re-renders with Exit pre-selected; Enter on Exit actually exits
    const effectiveDefault = escPressed ? 'exit' : defaultValue;
    escPressed = false;

    const commandResult = await wrapAsync(
      () =>
        escapableSelect(
          {
            message: `${emoji.donut} What would you like to do?`,
            choices: mainMenu,
            default: effectiveDefault,
            pageSize: 30,
            loop: true,
            theme: selectTheme,
          },
          { escLabel: 'exit' }
        ),
      (err) => (err instanceof Error ? err : new Error(String(err)))
    );

    if (!commandResult.ok) {
      if (commandResult.error.name === 'ExitPromptError') {
        showFarewell();
        break;
      }
      throw commandResult.error;
    }

    const command = commandResult.value;

    if (command === null) {
      escPressed = true;
      continue;
    }

    if (command === 'exit') {
      showFarewell();
      break;
    }

    // Direct action dispatch (next action + workflow actions)
    if (command.startsWith('action:')) {
      const parts = command.split(':');
      const group = parts[1] ?? '';
      const subCommand = parts[2] ?? '';
      log.newline();
      await executeCommand(group, subCommand);
      log.newline();
      await pressEnterToContinue();
      continue;
    }

    if (command === 'wizard') {
      const { runWizard } = await import('./wizard.ts');
      await runWizard();
      continue;
    }

    const subMenu = buildSubMenu(command, ctx);
    if (subMenu) {
      await handleSubMenu(command, subMenu);
    }
  }
}

/**
 * Handle a submenu with smooth transitions.
 * Rebuilds the submenu on each iteration so disabled states refresh after actions.
 * Workflow actions (create, refine, plan, start, etc.) return to main menu.
 */
async function handleSubMenu(
  commandGroup: string,
  initialSubMenu: { title: string; items: MenuItem[] }
): Promise<void> {
  let currentTitle = initialSubMenu.title;
  let currentItems = initialSubMenu.items;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    log.newline();
    const subCommandResult = await wrapAsync(
      () =>
        escapableSelect({
          message: `${emoji.donut} ${currentTitle}`,
          choices: currentItems,
          pageSize: 30,
          loop: true,
          theme: selectTheme,
        }),
      (err) => (err instanceof Error ? err : new Error(String(err)))
    );

    if (!subCommandResult.ok) {
      if (subCommandResult.error.name === 'ExitPromptError') {
        // Ctrl+C in submenu returns to main menu
        break;
      }
      throw subCommandResult.error;
    }

    const subCommand = subCommandResult.value;

    if (subCommand === null || subCommand === 'back') {
      break;
    }

    log.newline();
    await executeCommand(commandGroup, subCommand);
    log.newline();

    // Workflow actions return to main menu so next action updates
    if (isWorkflowAction(commandGroup, subCommand)) {
      break;
    }

    // Management actions stay in submenu — refresh context
    const { ctx: refreshedCtx } = await getMenuContext();
    const refreshedMenu = buildSubMenu(commandGroup, refreshedCtx);
    if (refreshedMenu) {
      currentTitle = refreshedMenu.title;
      currentItems = refreshedMenu.items;
    }
  }
}

/**
 * Execute a command by dispatching directly to the handler
 */
async function executeCommand(group: string, subCommand: string): Promise<void> {
  const groupHandlers = commandMap[group];
  const handler = groupHandlers?.[subCommand];

  if (!handler) {
    log.error(`Unknown command: ${group} ${subCommand}`);
    return;
  }

  const r = await wrapAsync(
    () => handler(),
    (err) => (err instanceof Error ? err : new Error(String(err)))
  );
  if (!r.ok) {
    log.error(r.error.message);
  }
}
