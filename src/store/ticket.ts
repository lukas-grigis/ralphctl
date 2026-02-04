import { getSprintFilePath } from '@src/utils/paths.ts';
import { readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { type Sprint, SprintSchema, type Ticket } from '@src/schemas/index.ts';
import { assertSprintStatus, resolveSprintId } from '@src/store/sprint.ts';
import { generateUuid8 } from '@src/utils/ids.ts';
import { getProject, type ProjectNotFoundError } from '@src/store/project.ts';

export class TicketNotFoundError extends Error {
  public readonly ticketId: string;

  constructor(ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.name = 'TicketNotFoundError';
    this.ticketId = ticketId;
  }
}

export class DuplicateTicketError extends Error {
  public readonly ticketId: string;

  constructor(ticketId: string) {
    super(`Ticket with external ID already exists: ${ticketId}`);
    this.name = 'DuplicateTicketError';
    this.ticketId = ticketId;
  }
}

async function getSprintData(sprintId?: string): Promise<Sprint> {
  const id = await resolveSprintId(sprintId);
  return readValidatedJson(getSprintFilePath(id), SprintSchema);
}

async function saveSprintData(sprint: Sprint): Promise<void> {
  await writeValidatedJson(getSprintFilePath(sprint.id), sprint, SprintSchema);
}

export interface AddTicketInput {
  externalId?: string;
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
  try {
    await getProject(input.projectName);
  } catch (err) {
    if ((err as ProjectNotFoundError).name === 'ProjectNotFoundError') {
      throw new Error(`Project '${input.projectName}' does not exist. Add it first with 'ralphctl project add'.`);
    }
    throw err;
  }

  // Check for duplicate external ID only if provided
  if (input.externalId && sprint.tickets.some((t) => t.externalId === input.externalId)) {
    throw new DuplicateTicketError(input.externalId);
  }

  const ticket: Ticket = {
    id: generateUuid8(),
    externalId: input.externalId,
    title: input.title,
    description: input.description,
    link: input.link,
    projectName: input.projectName,
    specStatus: 'pending',
  };

  sprint.tickets.push(ticket);
  await saveSprintData(sprint);
  return ticket;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  link?: string;
  externalId?: string;
}

export async function updateTicket(ticketId: string, updates: UpdateTicketInput, sprintId?: string): Promise<Ticket> {
  const sprint = await getSprintData(sprintId);

  // Check sprint status - must be draft to update tickets
  assertSprintStatus(sprint, ['draft'], 'update tickets');

  // Find by internal ID or external ID
  const ticketIdx = sprint.tickets.findIndex((t) => t.id === ticketId || t.externalId === ticketId);
  if (ticketIdx === -1) {
    throw new TicketNotFoundError(ticketId);
  }

  const ticket = sprint.tickets[ticketIdx];
  if (!ticket) {
    throw new TicketNotFoundError(ticketId);
  }

  // Check for duplicate external ID if changing it
  if (updates.externalId !== undefined && updates.externalId !== ticket.externalId) {
    const duplicate = sprint.tickets.find((t, idx) => idx !== ticketIdx && t.externalId === updates.externalId);
    if (duplicate) {
      throw new DuplicateTicketError(updates.externalId);
    }
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
  if (updates.externalId !== undefined) {
    ticket.externalId = updates.externalId || undefined;
  }

  await saveSprintData(sprint);
  return ticket;
}

export async function removeTicket(ticketId: string, sprintId?: string): Promise<void> {
  const sprint = await getSprintData(sprintId);

  // Check sprint status - must be draft to remove tickets
  assertSprintStatus(sprint, ['draft'], 'remove tickets');

  // Find by internal ID or external ID
  const index = sprint.tickets.findIndex((t) => t.id === ticketId || t.externalId === ticketId);
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
  // Find by internal ID or external ID
  const ticket = sprint.tickets.find((t) => t.id === ticketId || t.externalId === ticketId);
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
 * Check if all tickets have approved specs.
 */
export function allTicketsApproved(tickets: Ticket[]): boolean {
  return tickets.length > 0 && tickets.every((t) => t.specStatus === 'approved');
}

/**
 * Get tickets that still need spec refinement.
 */
export function getPendingTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => t.specStatus === 'pending');
}

/**
 * Format ticket for display: shows internal ID and external ID if present
 * Format: "[ID] Title" or "[ID] (EXT-123) Title"
 */
export function formatTicketDisplay(ticket: Ticket): string {
  const idPart = `[${ticket.id}]`;
  const externalPart = ticket.externalId ? ` (${ticket.externalId})` : '';
  return `${idPart}${externalPart} ${ticket.title}`;
}

/**
 * Format ticket ID for display: shows external ID if present, otherwise internal ID
 */
export function formatTicketId(ticket: Ticket): string {
  return ticket.externalId ?? ticket.id;
}
