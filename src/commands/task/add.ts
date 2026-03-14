import { resolve } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { error, muted } from '@src/theme/index.ts';
import { emoji, field, icons, log, showError, showNextSteps, showSuccess } from '@src/theme/ui.ts';
import { editorInput } from '@src/utils/editor-input.ts';
import { expandTilde, validateProjectPath } from '@src/utils/paths.ts';
import { addTask } from '@src/store/task.ts';
import { formatTicketDisplay, getTicket, listTickets } from '@src/store/ticket.ts';
import { getProject, listProjects } from '@src/store/project.ts';
import {
  assertSprintStatus,
  getSprint,
  NoCurrentSprintError,
  resolveSprintId,
  SprintStatusError,
} from '@src/store/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/utils/exit-codes.ts';
import { selectProjectRepository } from '@src/interactive/selectors.ts';

export interface TaskAddOptions {
  name?: string;
  description?: string;
  steps?: string[];
  ticket?: string;
  project?: string;
  interactive?: boolean; // Set by REPL or CLI (default true unless --no-interactive)
}

export async function taskAddCommand(options: TaskAddOptions = {}): Promise<void> {
  const isInteractive = options.interactive !== false;

  // FAIL FAST: Check sprint status before collecting any input
  const statusCheckR = await wrapAsync(async () => {
    const sprintId = await resolveSprintId();
    const sprint = await getSprint(sprintId);
    assertSprintStatus(sprint, ['draft'], 'add tasks');
  }, ensureError);
  if (!statusCheckR.ok) {
    const err = statusCheckR.error;
    if (err instanceof SprintStatusError) {
      const mainError = err.message.split('\n')[0] ?? err.message;
      showError(mainError);
      showNextSteps([
        ['ralphctl sprint close', 'close current sprint'],
        ['ralphctl sprint create', 'start a new draft sprint'],
      ]);
      log.newline();
      if (!isInteractive) exitWithCode(EXIT_ERROR);
      return;
    }
    if (err instanceof NoCurrentSprintError) {
      showError('No current sprint set.');
      showNextSteps([['ralphctl sprint create', 'create a new sprint']]);
      log.newline();
      if (!isInteractive) exitWithCode(EXIT_ERROR);
      return;
    }
    throw err;
  }

  let name: string;
  let description: string | undefined;
  let steps: string[];
  let ticketId: string | undefined;
  let projectPath: string | undefined;

  if (options.interactive === false) {
    // Non-interactive mode: validate required params
    const errors: string[] = [];
    const trimmedName = options.name?.trim();
    const trimmedProject = options.project?.trim();

    if (!trimmedName) {
      errors.push('--name is required');
    }

    // Project is required unless we can get it from a ticket
    if (!trimmedProject && !options.ticket) {
      errors.push('--project is required (or --ticket to inherit from ticket)');
    }

    if (errors.length > 0 || !trimmedName) {
      showError('Validation failed');
      for (const e of errors) {
        log.item(error(e));
      }
      log.newline();
      exitWithCode(EXIT_ERROR);
    }

    name = trimmedName;
    const trimmedDesc = options.description?.trim();
    description = trimmedDesc === '' ? undefined : trimmedDesc;
    steps = options.steps ?? [];
    const trimmedTicket = options.ticket?.trim();
    ticketId = trimmedTicket === '' ? undefined : trimmedTicket;

    // Get project path from ticket or option
    if (ticketId) {
      const resolvedTicketId = ticketId;
      const ticketProjectR = await wrapAsync(async () => {
        const ticket = await getTicket(resolvedTicketId);
        const project = await getProject(ticket.projectName);
        return project.repositories[0]?.path;
      }, ensureError);
      if (ticketProjectR.ok) {
        projectPath = ticketProjectR.value;
      } else {
        if (!trimmedProject) {
          showError(`Ticket not found: ${ticketId}`);
          console.log(muted('  Provide --project or a valid --ticket\n'));
          exitWithCode(EXIT_ERROR);
        }
        const validation = await validateProjectPath(trimmedProject);
        if (!validation.ok) {
          showError(`Invalid project path: ${validation.error.message}`);
          exitWithCode(EXIT_ERROR);
        }
        projectPath = resolve(trimmedProject);
      }
    } else if (trimmedProject) {
      const validation = await validateProjectPath(trimmedProject);
      if (!validation.ok) {
        showError(`Invalid project path: ${validation.error.message}`);
        exitWithCode(EXIT_ERROR);
      }
      projectPath = resolve(trimmedProject);
    } else {
      // This shouldn't happen due to earlier validation
      showError('--project is required');
      exitWithCode(EXIT_ERROR);
    }
  } else {
    // Interactive mode (default): prompt for missing params, use provided values as defaults
    name = await input({
      message: `${icons.task} Task name:`,
      default: options.name?.trim(),
      validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
    });

    const descR = await editorInput({
      message: 'Description (optional):',
      default: options.description?.trim(),
    });
    if (!descR.ok) {
      showError(`Editor input failed: ${descR.error.message}`);
      return;
    }
    description = descR.value;

    // Add steps one by one
    steps = options.steps ? [...options.steps] : [];
    const addSteps = await confirm({
      message: `${emoji.donut} ${steps.length > 0 ? `Add more steps? (${String(steps.length)} pre-filled)` : 'Add implementation steps?'}`,
      default: steps.length === 0,
    });

    if (addSteps) {
      let stepNum = steps.length + 1;
      let adding = true;
      while (adding) {
        const step = await input({
          message: `  Step ${String(stepNum)} (empty to finish):`,
        });
        if (step.trim()) {
          steps.push(step.trim());
          stepNum++;
        } else {
          adding = false;
        }
      }
    }

    // Optionally link to a ticket
    const tickets = await listTickets();

    if (tickets.length > 0) {
      const { select } = await import('@inquirer/prompts');
      const defaultTicketValue = options.ticket ? (tickets.find((t) => t.id === options.ticket)?.id ?? '') : '';
      const ticketChoice = await select({
        message: `${icons.ticket} Link to ticket:`,
        default: defaultTicketValue,
        choices: [
          { name: `${emoji.donut} None (select project/repo manually)`, value: '' },
          ...tickets.map((t) => ({
            name: `${icons.ticket} ${formatTicketDisplay(t)} ${muted(`(${t.projectName})`)}`,
            value: t.id,
          })),
        ],
      });
      if (ticketChoice) {
        ticketId = ticketChoice;
        const ticket = tickets.find((t) => t.id === ticketChoice);
        if (ticket) {
          const projR = await wrapAsync(() => getProject(ticket.projectName), ensureError);
          if (projR.ok) {
            const project = projR.value;
            // Auto-select first repo for ticket, or prompt if multiple
            if (project.repositories.length === 1) {
              projectPath = project.repositories[0]?.path;
            } else {
              // Multiple repos - let user pick
              const { select: selectRepo } = await import('@inquirer/prompts');
              projectPath = await selectRepo({
                message: `${emoji.donut} Select repository for this task:`,
                choices: project.repositories.map((r) => ({
                  name: `${r.name} (${r.path})`,
                  value: r.path,
                })),
              });
            }
          } else {
            log.warn(`Project '${ticket.projectName}' not found, will prompt for path.`);
          }
        }
      }
    } else if (options.ticket) {
      ticketId = options.ticket;
      const resolvedTicketId = ticketId;
      const tpR = await wrapAsync(async () => {
        const ticket = await getTicket(resolvedTicketId);
        const project = await getProject(ticket.projectName);
        return project.repositories[0]?.path;
      }, ensureError);
      if (tpR.ok) {
        projectPath = tpR.value;
      }
      // Will prompt for project below if not found
    }

    // If no project from ticket, use two-step selector
    if (projectPath === undefined) {
      const projects = await listProjects();

      if (projects.length > 0) {
        const { select } = await import('@inquirer/prompts');
        const choice = await select({
          message: `${icons.project} Select project:`,
          choices: [
            { name: `${icons.edit} Enter path manually`, value: '__manual__' },
            { name: `${emoji.donut} Select project/repository`, value: '__select__' },
          ],
        });

        if (choice === '__manual__') {
          projectPath = await input({
            message: `${icons.project} Project path:`,
            default: options.project?.trim() ?? process.cwd(),
            validate: async (v) => {
              const result = await validateProjectPath(v.trim());
              return result.ok ? true : result.error.message;
            },
          });
          projectPath = resolve(expandTilde(projectPath.trim()));
        } else {
          // Two-step selector: project → repository
          const selectedPath = await selectProjectRepository('Select repository:');
          if (!selectedPath) {
            showError('No repository selected');
            exitWithCode(EXIT_ERROR);
          }
          projectPath = selectedPath;
        }
      } else {
        projectPath = await input({
          message: `${icons.project} Project path:`,
          default: options.project?.trim() ?? process.cwd(),
          validate: async (v) => {
            const result = await validateProjectPath(v.trim());
            return result.ok ? true : result.error.message;
          },
        });
        projectPath = resolve(expandTilde(projectPath.trim()));
      }
    }

    name = name.trim();
    const trimmedDescription = description.trim();
    description = trimmedDescription === '' ? undefined : trimmedDescription;
  }

  // projectPath must be set by this point
  if (!projectPath) {
    showError('Project path is required');
    exitWithCode(EXIT_ERROR);
  }

  const addR = await wrapAsync(() => addTask({ name, description, steps, ticketId, projectPath }), ensureError);
  if (!addR.ok) {
    if (addR.error instanceof SprintStatusError) {
      // Fallback handler (shouldn't reach here due to early check)
      const mainError = addR.error.message.split('\n')[0] ?? addR.error.message;
      showError(mainError);
      showNextSteps([
        ['ralphctl sprint close', 'close current sprint'],
        ['ralphctl sprint create', 'start a new draft sprint'],
      ]);
      log.newline();
      if (!isInteractive) exitWithCode(EXIT_ERROR);
      return;
    }
    throw addR.error;
  }

  const task = addR.value;
  showSuccess('Task added!', [
    ['ID', task.id],
    ['Name', task.name],
    ['Project', task.projectPath],
    ['Order', String(task.order)],
  ]);

  if (task.ticketId) {
    console.log(field('Ticket', task.ticketId));
  }
  if (task.steps.length > 0) {
    console.log(field('Steps', ''));
    task.steps.forEach((step, i) => {
      console.log(muted(`    ${String(i + 1)}. ${step}`));
    });
  }
  console.log('');
}
