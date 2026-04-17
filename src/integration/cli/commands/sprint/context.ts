import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { log, showNextStep, showWarning } from '@src/integration/ui/theme/ui.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { formatTicketDisplay } from '@src/integration/persistence/ticket.ts';
import { getProjectById, getRepoById } from '@src/integration/persistence/project.ts';
import { selectSprint } from '@src/integration/cli/commands/shared/selectors.ts';

export async function sprintContextCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  let id: string;
  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    const selected = await selectSprint('Select sprint to show context for:');
    if (!selected) {
      showWarning('No sprints available.');
      showNextStep('ralphctl sprint create', 'create a sprint first');
      log.newline();
      return;
    }
    id = selected;
  } else {
    id = idR.value;
  }

  const sprint = await getSprint(id);
  const tasks = await listTasks(id);

  console.log(`# Sprint: ${sprint.name}`);
  console.log(`ID: ${sprint.id}`);
  console.log(`Status: ${sprint.status}`);

  const projectR = await wrapAsync(() => getProjectById(sprint.projectId), ensureError);
  const project = projectR.ok ? projectR.value : null;
  if (project) {
    console.log(`Project: ${project.displayName} (${project.name})`);
  }
  console.log('');

  console.log('## Tickets');
  console.log('');
  if (sprint.tickets.length === 0) {
    console.log('_No tickets defined_');
  } else {
    if (project) {
      const repoPaths = project.repositories.map((r) => `${r.name} (${r.path})`);
      console.log(`Repositories: ${repoPaths.join(', ')}`);
    } else {
      console.log('Repositories: (project not found)');
    }
    console.log('');

    for (const ticket of sprint.tickets) {
      const reqBadge = ticket.requirementStatus === 'approved' ? ' [approved]' : ' [pending]';
      console.log(`#### ${formatTicketDisplay(ticket)}${reqBadge}`);

      if (ticket.description) {
        console.log('');
        console.log(ticket.description);
      }

      if (ticket.link) {
        console.log('');
        console.log(`Link: ${ticket.link}`);
      }

      if (ticket.requirements) {
        console.log('');
        console.log('**Refined Requirements:**');
        console.log('');
        console.log(ticket.requirements);
      }
      console.log('');
    }
  }

  console.log('## Tasks');
  console.log('');
  if (tasks.length === 0) {
    console.log('_No tasks defined yet_');
  } else {
    for (const task of tasks) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      console.log(`### ${task.id}: ${task.name}${ticketRef}`);
      const repoR = await wrapAsync(() => getRepoById(task.repoId), ensureError);
      const repoLabel = repoR.ok ? `${repoR.value.repo.name} (${repoR.value.repo.path})` : task.repoId;
      console.log(`Status: ${task.status} | Order: ${String(task.order)} | Repo: ${repoLabel}`);
      if (task.blockedBy.length > 0) {
        console.log(`Blocked By: ${task.blockedBy.join(', ')}`);
      }
      if (task.description) {
        console.log('');
        console.log(task.description);
      }
      if (task.steps.length > 0) {
        console.log('');
        console.log('Steps:');
        task.steps.forEach((step, i) => {
          console.log(`${String(i + 1)}. ${step}`);
        });
      }
      console.log('');
    }
  }
}
