import { input, select } from '@inquirer/prompts';
import {
  clearScreen,
  emoji,
  formatMuted,
  isTTY,
  log,
  printHeader,
  printSeparator,
  progressiveReveal,
  showBanner,
} from '@src/theme/ui.ts';
import {
  applyGradientLines,
  banner,
  colors,
  getQuoteForContext,
  gradients,
  isColorSupported,
} from '@src/theme/index.ts';
import { mainMenuItems, type MenuItem, subMenus } from './menu.ts';
import { getStatusLine, showDashboard } from './dashboard.ts';

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
    close: () => sprintCloseCommand([]),
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
 * Animated banner reveal: progressive line-by-line reveal with gradient.
 * Falls back to instant display when not a TTY.
 */
async function showAnimatedBanner(): Promise<void> {
  const bannerLines = isColorSupported
    ? applyGradientLines(banner.art, gradients.donut).split('\n')
    : banner.art.split('\n');

  if (isTTY()) {
    await progressiveReveal(bannerLines, 40);
  } else {
    for (const line of bannerLines) {
      console.log(line);
    }
  }

  const quote = getQuoteForContext('idle');
  console.log(colors.muted(`  "${quote}"\n`));
}

/**
 * Show the persistent status header (compact sprint context line).
 */
async function showStatusHeader(): Promise<void> {
  const statusLine = await getStatusLine();
  printSeparator();
  console.log(`  ${statusLine}`);
  printSeparator();
}

/**
 * Run the interactive REPL mode
 */
export async function interactiveMode(): Promise<void> {
  clearScreen();

  // Animated welcome on first launch
  await showAnimatedBanner();
  await showDashboard();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    try {
      const command = await select({
        message: `${emoji.donut} What would you like to do?`,
        choices: mainMenuItems,
        pageSize: 15,
        loop: false,
        theme: selectTheme,
      });

      if (command === 'exit') {
        showFarewell();
        break;
      }

      const subMenu = subMenus[command];
      if (subMenu) {
        await handleSubMenu(command, subMenu.title, subMenu.items);
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
 */
async function handleSubMenu(commandGroup: string, title: string, items: MenuItem[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control variable
  while (true) {
    try {
      log.newline();
      await showStatusHeader();
      printHeader(title, emoji.donut);

      const subCommand = await select({
        message: `${emoji.donut} ${title}`,
        choices: items,
        pageSize: 15,
        loop: false,
        theme: selectTheme,
      });

      if (subCommand === 'back') {
        // Return to main menu — show banner + dashboard again
        clearScreen();
        showBanner();
        await showDashboard();
        break;
      }

      log.newline();
      await executeCommand(commandGroup, subCommand);

      log.newline();
      await input({
        message: formatMuted('Press Enter to continue...'),
      });
    } catch (err) {
      if ((err as Error).name === 'ExitPromptError') {
        // Ctrl+C in submenu returns to main menu
        clearScreen();
        showBanner();
        await showDashboard();
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
