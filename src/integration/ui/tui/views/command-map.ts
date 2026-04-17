/**
 * Command dispatch table used by `HomeView` to run the user's selected action.
 *
 * Each handler renders any prompts through `getPrompt()` so they surface
 * through the Ink `<PromptHost />`.
 */

import { getPrompt } from '@src/integration/bootstrap.ts';
import { getAiProvider, getEditor, getEvaluationIterations } from '@src/integration/persistence/config.ts';

// Project
import { projectAddCommand } from '@src/integration/cli/commands/project/add.ts';
import { projectListCommand } from '@src/integration/cli/commands/project/list.ts';
import { projectShowCommand } from '@src/integration/cli/commands/project/show.ts';
import { projectRemoveCommand } from '@src/integration/cli/commands/project/remove.ts';
import { projectRepoAddCommand, projectRepoRemoveCommand } from '@src/integration/cli/commands/project/repo.ts';

// Sprint
import { sprintCreateCommand } from '@src/integration/cli/commands/sprint/create.ts';
import { sprintListCommand } from '@src/integration/cli/commands/sprint/list.ts';
import { sprintShowCommand } from '@src/integration/cli/commands/sprint/show.ts';
import { sprintContextCommand } from '@src/integration/cli/commands/sprint/context.ts';
import { sprintCurrentCommand } from '@src/integration/cli/commands/sprint/current.ts';
import { sprintRefineCommand } from '@src/integration/cli/commands/sprint/refine.ts';
import { sprintIdeateCommand } from '@src/integration/cli/commands/sprint/ideate.ts';
import { sprintPlanCommand } from '@src/integration/cli/commands/sprint/plan.ts';
import { sprintStartCommand } from '@src/integration/cli/commands/sprint/start.ts';
import { sprintCloseCommand } from '@src/integration/cli/commands/sprint/close.ts';
import { sprintDeleteCommand } from '@src/integration/cli/commands/sprint/delete.ts';
import { sprintRequirementsCommand } from '@src/integration/cli/commands/sprint/requirements.ts';
import { sprintHealthCommand } from '@src/integration/cli/commands/sprint/health.ts';

// Ticket
import { ticketAddCommand } from '@src/integration/cli/commands/ticket/add.ts';
import { ticketEditCommand } from '@src/integration/cli/commands/ticket/edit.ts';
import { ticketListCommand } from '@src/integration/cli/commands/ticket/list.ts';
import { ticketShowCommand } from '@src/integration/cli/commands/ticket/show.ts';
import { ticketRemoveCommand } from '@src/integration/cli/commands/ticket/remove.ts';
import { ticketRefineCommand } from '@src/integration/cli/commands/ticket/refine.ts';

// Task
import { taskAddCommand } from '@src/integration/cli/commands/task/add.ts';
import { taskImportCommand } from '@src/integration/cli/commands/task/import.ts';
import { taskListCommand } from '@src/integration/cli/commands/task/list.ts';
import { taskShowCommand } from '@src/integration/cli/commands/task/show.ts';
import { taskStatusCommand } from '@src/integration/cli/commands/task/status.ts';
import { taskNextCommand } from '@src/integration/cli/commands/task/next.ts';
import { taskReorderCommand } from '@src/integration/cli/commands/task/reorder.ts';
import { taskRemoveCommand } from '@src/integration/cli/commands/task/remove.ts';

// Progress
import { progressLogCommand } from '@src/integration/cli/commands/progress/log.ts';
import { progressShowCommand } from '@src/integration/cli/commands/progress/show.ts';

// Config
import { configSetCommand, configShowCommand } from '@src/integration/cli/commands/config/config.ts';

// Doctor
import { doctorCommand } from '@src/integration/cli/commands/doctor/doctor.ts';

type CommandHandler = () => Promise<void>;

export const commandMap: Record<string, Record<string, CommandHandler>> = {
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
    'close --create-pr': () => sprintCloseCommand(['--create-pr']),
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
      const choice = await getPrompt().select<'claude' | 'copilot'>({
        message: 'Which AI buddy should help with my homework?',
        choices: [
          { label: 'Claude Code', value: 'claude' },
          { label: 'GitHub Copilot', value: 'copilot' },
        ],
        default: (await getAiProvider()) ?? undefined,
      });
      await configSetCommand(['provider', choice]);
    },
    'set editor': async () => {
      const current = await getEditor();
      const value = await getPrompt().input({
        message: 'Which editor should open for refinement?',
        default: current ?? undefined,
      });
      if (value.trim()) {
        await configSetCommand(['editor', value.trim()]);
      }
    },
    'set evaluationIterations': async () => {
      const current = await getEvaluationIterations();
      const value = await getPrompt().input({
        message: 'How many evaluation loops? (0 = disabled)',
        default: String(current),
      });
      await configSetCommand(['evaluationIterations', value.trim()]);
    },
  },
};
