import { ensureError, wrapAsync } from '@src/utils/result-helpers.ts';
import { log, showNextStep, showWarning } from '@src/theme/ui.ts';
import { getSprint, resolveSprintId } from '@src/store/sprint.ts';
import { listTasks } from '@src/store/task.ts';
import { formatTicketDisplay, groupTicketsByProject } from '@src/store/ticket.ts';
import { getProject } from '@src/store/project.ts';
import { selectSprint } from '@src/interactive/selectors.ts';

export async function sprintContextCommand(args: string[]): Promise<void> {
  const sprintId = args[0];

  let id: string;
  const idR = await wrapAsync(() => resolveSprintId(sprintId), ensureError);
  if (!idR.ok) {
    // No current sprint set - offer selection
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

  // Output in a format useful for the AI provider
  console.log(`# Sprint: ${sprint.name}`);
  console.log(`ID: ${sprint.id}`);
  console.log(`Status: ${sprint.status}`);
  console.log('');

  // Tickets grouped by project
  console.log('## Tickets');
  console.log('');
  if (sprint.tickets.length === 0) {
    console.log('_No tickets defined_');
  } else {
    const ticketsByProject = groupTicketsByProject(sprint.tickets);

    for (const [projectName, tickets] of ticketsByProject) {
      console.log(`### Project: ${projectName}`);

      // Get project repositories for context
      const projectR = await wrapAsync(() => getProject(projectName), ensureError);
      if (projectR.ok) {
        const repoPaths = projectR.value.repositories.map((r) => `${r.name} (${r.path})`);
        console.log(`Repositories: ${repoPaths.join(', ')}`);
      } else {
        console.log('Repositories: (project not found)');
      }
      console.log('');

      for (const ticket of tickets) {
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

        // Include refined requirements if available
        if (ticket.requirements) {
          console.log('');
          console.log('**Refined Requirements:**');
          console.log('');
          console.log(ticket.requirements);
        }
        console.log('');
      }
    }
  }

  // Tasks section
  console.log('## Tasks');
  console.log('');
  if (tasks.length === 0) {
    console.log('_No tasks defined yet_');
  } else {
    for (const task of tasks) {
      const ticketRef = task.ticketId ? ` [${task.ticketId}]` : '';
      console.log(`### ${task.id}: ${task.name}${ticketRef}`);
      console.log(`Status: ${task.status} | Order: ${String(task.order)} | Project: ${task.projectPath}`);
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
