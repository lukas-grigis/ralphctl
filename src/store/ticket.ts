import { getSprintFilePath } from '@src/utils/paths.ts';
import { readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { type Sprint, SprintSchema, type Ticket } from '@src/schemas/index.ts';
import { assertSprintStatus, resolveSprintId } from '@src/store/sprint.ts';
import { generateUuid8 } from '@src/utils/ids.ts';
import { projectExists } from '@src/store/project.ts';
import { ProjectNotFoundError, TicketNotFoundError } from '@src/errors.ts';

export { TicketNotFoundError } from '@src/errors.ts';

async function getSprintData(sprintId?: string): Promise<Sprint> {
  const id = await resolveSprintId(sprintId);
  const result = await readValidatedJson(getSprintFilePath(id), SprintSchema);
  if (!result.ok) throw result.error;
  return result.value;
}

async function saveSprintData(sprint: Sprint): Promise<void> {
  const result = await writeValidatedJson(getSprintFilePath(sprint.id), sprint, SprintSchema);
  if (!result.ok) throw result.error;
}

export interface AddTicketInput {
  title: string;
  description?: string;
  link?: string;
  projectName: string;
}

export async function addTicket(input: AddTicketInput, sprintId?: string): Promise<Ticket> {
  const sprint = await getSprintData(sprintId);

  // Check sprint status - must be draft to add tickets
  assertSprintStatus(sprint, ['draft'], 'add tickets');

  // Validate that the project exists
  if (!(await projectExists(input.projectName))) {
    throw new ProjectNotFoundError(input.projectName);
  }

  const ticket: Ticket = {
    id: generateUuid8(),
    title: input.title,
    description: input.description,
    link: input.link,
    projectName: input.projectName,
    requirementStatus: 'pending',
  };

  sprint.tickets.push(ticket);
  await saveSprintData(sprint);
  return ticket;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  link?: string;
}

export async function updateTicket(ticketId: string, updates: UpdateTicketInput, sprintId?: string): Promise<Ticket> {
  const sprint = await getSprintData(sprintId);

  // Check sprint status - must be draft to update tickets
  assertSprintStatus(sprint, ['draft'], 'update tickets');

  const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticketId);
  if (ticketIdx === -1) {
    throw new TicketNotFoundError(ticketId);
  }

  const ticket = sprint.tickets[ticketIdx];
  if (!ticket) {
    throw new TicketNotFoundError(ticketId);
  }

  // Apply updates
  if (updates.title !== undefined) {
    ticket.title = updates.title;
  }
  if (updates.description !== undefined) {
    ticket.description = updates.description || undefined;
  }
  if (updates.link !== undefined) {
    ticket.link = updates.link || undefined;
  }

  await saveSprintData(sprint);
  return ticket;
}

export async function removeTicket(ticketId: string, sprintId?: string): Promise<void> {
  const sprint = await getSprintData(sprintId);

  // Check sprint status - must be draft to remove tickets
  assertSprintStatus(sprint, ['draft'], 'remove tickets');

  const index = sprint.tickets.findIndex((t) => t.id === ticketId);
  if (index === -1) {
    throw new TicketNotFoundError(ticketId);
  }
  sprint.tickets.splice(index, 1);
  await saveSprintData(sprint);
}

export async function listTickets(sprintId?: string): Promise<Ticket[]> {
  const sprint = await getSprintData(sprintId);
  return sprint.tickets;
}

export async function getTicket(ticketId: string, sprintId?: string): Promise<Ticket> {
  const sprint = await getSprintData(sprintId);
  const ticket = sprint.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw new TicketNotFoundError(ticketId);
  }
  return ticket;
}

/**
 * Get a ticket by title (for tickets without an external ID).
 */
export async function getTicketByTitle(title: string, sprintId?: string): Promise<Ticket | undefined> {
  const sprint = await getSprintData(sprintId);
  return sprint.tickets.find((t) => t.title === title);
}

/**
 * Group tickets by their project name.
 */
export function groupTicketsByProject(tickets: Ticket[]): Map<string, Ticket[]> {
  const grouped = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const existing = grouped.get(ticket.projectName) ?? [];
    existing.push(ticket);
    grouped.set(ticket.projectName, existing);
  }
  return grouped;
}

/**
 * Check if all tickets have approved requirements.
 */
export function allRequirementsApproved(tickets: Ticket[]): boolean {
  return tickets.length > 0 && tickets.every((t) => t.requirementStatus === 'approved');
}

/**
 * Get tickets that still need requirement refinement.
 */
export function getPendingRequirements(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => t.requirementStatus === 'pending');
}

/**
 * Format ticket for display: "[ID] Title"
 */
export function formatTicketDisplay(ticket: Ticket): string {
  return `[${ticket.id}] ${ticket.title}`;
}

/**
 * Format ticket ID for display.
 */
export function formatTicketId(ticket: Ticket): string {
  return ticket.id;
}
