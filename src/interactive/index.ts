import { input, select } from '@inquirer/prompts';
import { clearScreen, emoji, formatMuted, log, printSeparator, showBanner } from '@src/theme/ui.ts';
import { colors, getQuoteForContext } from '@src/theme/index.ts';
import { buildMainMenu, buildSubMenu, type MenuContext, type MenuItem } from './menu.ts';
import { showDashboard } from './dashboard.ts';
import { getCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { listProjects } from '@src/store/project.ts';
import { getTasks } from '@src/store/task.ts';
import { allRequirementsApproved, getPendingRequirements } from '@src/store/ticket.ts';

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
    plan: () => sprintPlanCommand([]),
    start: () => sprintStartCommand([]),
    requirements: () => sprintRequirementsCommand([]),
    health: () => sprintHealthCommand(),
    close: () => sprintCloseCommand([]),
    delete: () => sprintDeleteCommand([]),
  },
  ticket: {
    add: () => ticketAddCommand({ interactive: true }),
    edit: () => ticketEditCommand(undefined, { interactive: true }),
    list: () => ticketListCommand([]),
    show: () => ticketShowCommand([]),
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
 * Show the welcome banner with gradient styling and a quote.
 */
function showWelcomeBanner(): void {
  showBanner();
  const quote = getQuoteForContext('idle');
  console.log(colors.muted(`       "${quote}"`));
  console.log('');
}

/**
 * Gather current application state for context-aware menus.
 * Swallows errors gracefully — missing data means empty context.
 */
async function getMenuContext(): Promise<MenuContext> {
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
  };

  try {
    const projects = await listProjects();
    ctx.hasProjects = projects.length > 0;
    ctx.projectCount = projects.length;
  } catch {
    // No projects file yet
  }

  try {
    const sprintId = await getCurrentSprint();
    if (sprintId) {
      ctx.currentSprintId = sprintId;
      const sprint = await getSprint(sprintId);
      ctx.currentSprintName = sprint.name;
      ctx.currentSprintStatus = sprint.status;
      ctx.ticketCount = sprint.tickets.length;
      ctx.pendingRequirements = getPendingRequirements(sprint.tickets).length;
      ctx.allRequirementsApproved = allRequirementsApproved(sprint.tickets);

      try {
        const tasks = await getTasks(sprintId);
        ctx.taskCount = tasks.length;
        ctx.tasksDone = tasks.filter((t) => t.status === 'done').length;
        ctx.tasksInProgress = tasks.filter((t) => t.status === 'in_progress').length;
      } catch {
        // No tasks file yet
      }
    }
  } catch {
    // No current sprint or sprint file missing
  }

  return ctx;
}

/**
 * Run the interactive REPL mode
 */
export async function interactiveMode(): Promise<void> {
  clearScreen();

  // Welcome banner on first launch
  showWelcomeBanner();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    try {
      const ctx = await getMenuContext();
      const mainMenu = buildMainMenu(ctx);

      const command = await select({
        message: `${emoji.donut} What would you like to do?`,
        choices: mainMenu,
        pageSize: 15,
        loop: true,
        theme: selectTheme,
      });

      if (command === 'exit') {
        showFarewell();
        break;
      }

      if (command === 'status') {
        log.newline();
        await showDashboard();
        log.newline();
        await input({
          message: formatMuted('Press Enter to continue...'),
        });
        continue;
      }

      if (command === 'wizard') {
        const { runWizard } = await import('./wizard.ts');
        await runWizard();
        continue;
      }

      if (command === 'switch-sprint') {
        const { sprintSwitchCommand } = await import('@src/commands/sprint/switch.ts');
        log.newline();
        await sprintSwitchCommand();
        log.newline();
        await input({
          message: formatMuted('Press Enter to continue...'),
        });
        clearScreen();
        showBanner();
        continue;
      }

      const subMenu = buildSubMenu(command, ctx);
      if (subMenu) {
        await handleSubMenu(command, subMenu);
      }
    } catch (err) {
      if ((err as Error).name === 'ExitPromptError') {
        showFarewell();
        break;
      }
      throw err;
    }
  }
}

/**
 * Handle a submenu with persistent status header and smooth transitions.
 * Rebuilds the submenu on each iteration so disabled states refresh after actions.
 */
async function handleSubMenu(
  commandGroup: string,
  initialSubMenu: { title: string; items: MenuItem[] }
): Promise<void> {
  let currentTitle = initialSubMenu.title;
  let currentItems = initialSubMenu.items;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    try {
      log.newline();
      const subCommand = await select({
        message: `${emoji.donut} ${currentTitle}`,
        choices: currentItems,
        pageSize: 15,
        loop: true,
        theme: selectTheme,
      });

      if (subCommand === 'back') {
        // Return to main menu — show banner again
        clearScreen();
        showBanner();
        break;
      }

      log.newline();
      await executeCommand(commandGroup, subCommand);

      log.newline();
      await input({
        message: formatMuted('Press Enter to continue...'),
      });

      // Refresh menu context after action so disabled states update
      const refreshedCtx = await getMenuContext();
      const refreshedMenu = buildSubMenu(commandGroup, refreshedCtx);
      if (refreshedMenu) {
        currentTitle = refreshedMenu.title;
        currentItems = refreshedMenu.items;
      }
    } catch (err) {
      if ((err as Error).name === 'ExitPromptError') {
        // Ctrl+C in submenu returns to main menu
        clearScreen();
        showBanner();
        break;
      }
      throw err;
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

  try {
    await handler();
  } catch (err) {
    if (err instanceof Error) {
      log.error(err.message);
    }
  }
}
