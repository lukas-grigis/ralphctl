import { input, editor, select } from '@inquirer/prompts';
import { success, info } from '@src/utils/colors.ts';
import { addTask } from '@src/services/task.ts';
import { listTickets } from '@src/services/ticket.ts';

export async function taskAddCommand(): Promise<void> {
  const name = await input({
    message: 'Task name:',
    validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
  });

  const description = await input({
    message: 'Description (optional):',
  });

  const stepsText = await editor({
    message: 'Implementation steps (one per line, optional):',
    default: '',
    waitForUserInput: false,
  });
  const steps = stepsText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Optionally link to a ticket
  const tickets = await listTickets();
  let ticketId: string | undefined;

  if (tickets.length > 0) {
    const ticketChoice = await select({
      message: 'Link to ticket (optional):',
      choices: [
        { name: 'None', value: '' },
        ...tickets.map((t) => ({
          name: `${t.id}: ${t.title}`,
          value: t.id,
        })),
      ],
    });
    if (ticketChoice) {
      ticketId = ticketChoice;
    }
  }

  const task = await addTask({
    name,
    description: description || undefined,
    steps,
    ticketId,
  });

  console.log(success('\nTask added successfully!'));
  console.log(info('  ID:    ') + task.id);
  console.log(info('  Name:  ') + task.name);
  console.log(info('  Order: ') + String(task.order));
  if (task.ticketId) {
    console.log(info('  Ticket:') + task.ticketId);
  }
  if (task.steps.length > 0) {
    console.log(info('  Steps:'));
    task.steps.forEach((step, i) => {
      console.log(`    ${String(i + 1)}. ${step}`);
    });
  }
  console.log('');
}
