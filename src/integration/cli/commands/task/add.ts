import { getPrompt } from '@src/application/bootstrap.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { error, muted } from '@src/integration/ui/theme/theme.ts';
import { emoji, field, icons, log, showError, showNextSteps, showSuccess } from '@src/integration/ui/theme/ui.ts';
import { editorInput } from '@src/integration/ui/prompts/editor-input.ts';
import { addTask } from '@src/integration/persistence/task.ts';
import { formatTicketDisplay, getTicket, listTickets } from '@src/integration/persistence/ticket.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import {
  assertSprintStatus,
  getSprint,
  NoCurrentSprintError,
  resolveSprintId,
  SprintStatusError,
} from '@src/integration/persistence/sprint.ts';
import { EXIT_ERROR, exitWithCode } from '@src/application/exit-codes.ts';
import type { Repository } from '@src/domain/models.ts';

export interface TaskAddOptions {
  name?: string;
  description?: string;
  steps?: string[];
  ticket?: string;
  /** Repo name or id within the sprint's project. */
  repo?: string;
  interactive?: boolean;
}

export async function taskAddCommand(options: TaskAddOptions = {}): Promise<void> {
  const isInteractive = options.interactive !== false;

  // FAIL FAST: Check sprint status and load project before any prompt
  const preflightR = await wrapAsync(async () => {
    const sprintId = await resolveSprintId();
    const sprint = await getSprint(sprintId);
    assertSprintStatus(sprint, ['draft'], 'add tasks');
    const project = await getProjectById(sprint.projectId);
    return { sprint, project };
  }, ensureError);

  if (!preflightR.ok) {
    const err = preflightR.error;
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

  const { project } = preflightR.value;
  const repos = project.repositories;

  function resolveRepo(flag: string | undefined): Repository | null {
    if (!flag) return null;
    const trimmed = flag.trim();
    return repos.find((r) => r.id === trimmed || r.name === trimmed) ?? null;
  }

  let name: string;
  let description: string | undefined;
  let steps: string[];
  let ticketId: string | undefined;
  let repo: Repository | null = null;

  if (!isInteractive) {
    const errors: string[] = [];
    const trimmedName = options.name?.trim();
    if (!trimmedName) {
      errors.push('--name is required');
    }

    // Repo: pick by flag, ticket's first repo, or single-repo project.
    repo = resolveRepo(options.repo);
    const ticketFlag = options.ticket;
    if (!repo && ticketFlag) {
      const ticketR = await wrapAsync(() => getTicket(ticketFlag), ensureError);
      if (ticketR.ok) {
        const affected = ticketR.value.affectedRepoIds ?? [];
        const firstId = affected[0];
        if (firstId) repo = repos.find((r) => r.id === firstId) ?? null;
      }
    }
    const onlyRepo = repos[0];
    if (!repo && repos.length === 1 && onlyRepo) repo = onlyRepo;
    if (!repo) {
      errors.push('--repo is required (or --ticket to inherit, or project must have a single repo)');
    }

    if (errors.length > 0 || !trimmedName || !repo) {
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
  } else {
    name = await getPrompt().input({
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

    steps = options.steps ? [...options.steps] : [];
    const addSteps = await getPrompt().confirm({
      message: `${emoji.donut} ${steps.length > 0 ? `Add more steps? (${String(steps.length)} pre-filled)` : 'Add implementation steps?'}`,
      default: steps.length === 0,
    });

    if (addSteps) {
      let stepNum = steps.length + 1;
      let adding = true;
      while (adding) {
        const step = await getPrompt().input({
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
      const defaultTicketValue = options.ticket ? (tickets.find((t) => t.id === options.ticket)?.id ?? '') : '';
      const ticketChoice = await getPrompt().select({
        message: `${icons.ticket} Link to ticket:`,
        default: defaultTicketValue,
        choices: [
          { label: `${emoji.donut} None (select repo manually)`, value: '' },
          ...tickets.map((t) => ({
            label: `${icons.ticket} ${formatTicketDisplay(t)}`,
            value: t.id,
          })),
        ],
      });
      if (ticketChoice) {
        ticketId = ticketChoice;
        const ticket = tickets.find((t) => t.id === ticketChoice);
        const affected = ticket?.affectedRepoIds ?? [];
        // Inherit repo from ticket's affectedRepoIds if unambiguous.
        if (affected.length === 1) {
          const firstAffected = affected[0];
          if (firstAffected) repo = repos.find((r) => r.id === firstAffected) ?? null;
        }
      }
    }

    // Repo picker — either flag-provided, inherited, auto-picked, or prompted.
    repo ??= resolveRepo(options.repo);
    const onlyRepoInteractive = repos[0];
    if (!repo && repos.length === 1 && onlyRepoInteractive) repo = onlyRepoInteractive;
    if (!repo) {
      const repoId = await getPrompt().select<string>({
        message: `${icons.project} Select repository for this task:`,
        choices: repos.map((r) => ({
          label: `${r.name} ${muted(`(${r.path})`)}`,
          value: r.id,
          description: r.path,
        })),
      });
      repo = repos.find((r) => r.id === repoId) ?? null;
    }

    if (!repo) {
      showError('Repository required');
      exitWithCode(EXIT_ERROR);
    }

    name = name.trim();
    const trimmedDescription = description.trim();
    description = trimmedDescription === '' ? undefined : trimmedDescription;
  }

  // Both branches above call `exitWithCode` (returns `never`) before reaching
  // here if `repo` is nullish — so `repo` is guaranteed non-null below.
  const addR = await wrapAsync(() => addTask({ name, description, steps, ticketId, repoId: repo.id }), ensureError);
  if (!addR.ok) {
    if (addR.error instanceof SprintStatusError) {
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
    ['Repo', `${repo.name} (${repo.path})`],
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
