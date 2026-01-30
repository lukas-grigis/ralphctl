import { input } from '@inquirer/prompts';
import { success, info, error } from '@src/utils/colors.ts';
import { addTicket, DuplicateTicketError } from '@src/services/ticket.ts';

export async function ticketAddCommand(): Promise<void> {
  const id = await input({
    message: 'Ticket ID (e.g., TICKET-001):',
    validate: (v) => (v.trim().length > 0 ? true : 'ID is required'),
  });

  const title = await input({
    message: 'Title:',
    validate: (v) => (v.trim().length > 0 ? true : 'Title is required'),
  });

  const description = await input({
    message: 'Description (optional):',
  });

  const link = await input({
    message: 'Link (optional):',
    validate: (v) => {
      if (!v) return true;
      try {
        new URL(v);
        return true;
      } catch {
        return 'Invalid URL format';
      }
    },
  });

  try {
    const ticket = await addTicket({
      id: id.trim(),
      title: title.trim(),
      description: description.trim() || undefined,
      link: link.trim() || undefined,
    });

    console.log(success('\nTicket added successfully!'));
    console.log(info('  ID:    ') + ticket.id);
    console.log(info('  Title: ') + ticket.title);
    if (ticket.description) {
      console.log(info('  Desc:  ') + ticket.description);
    }
    if (ticket.link) {
      console.log(info('  Link:  ') + ticket.link);
    }
    console.log('');
  } catch (err) {
    if (err instanceof DuplicateTicketError) {
      console.log(error(`\nTicket with ID "${id}" already exists.\n`));
    } else {
      throw err;
    }
  }
}
