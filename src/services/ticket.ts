import { getScopeFilePath } from '@src/utils/paths.ts';
import { readValidatedJson, writeValidatedJson } from '@src/utils/storage.ts';
import { ScopeSchema, type Scope, type Ticket } from '@src/schemas/index.ts';
import { resolveScopeId } from '@src/services/scope.ts';

export class TicketNotFoundError extends Error {
  constructor(ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.name = 'TicketNotFoundError';
  }
}

export class DuplicateTicketError extends Error {
  constructor(ticketId: string) {
    super(`Ticket already exists: ${ticketId}`);
    this.name = 'DuplicateTicketError';
  }
}

async function getScopeData(scopeId?: string): Promise<Scope> {
  const id = await resolveScopeId(scopeId);
  return readValidatedJson(getScopeFilePath(id), ScopeSchema);
}

async function saveScopeData(scope: Scope): Promise<void> {
  await writeValidatedJson(getScopeFilePath(scope.id), scope, ScopeSchema);
}

export interface AddTicketInput {
  id: string;
  title: string;
  description?: string;
  link?: string;
}

export async function addTicket(input: AddTicketInput, scopeId?: string): Promise<Ticket> {
  const scope = await getScopeData(scopeId);

  // Check for duplicate
  if (scope.tickets.some((t) => t.id === input.id)) {
    throw new DuplicateTicketError(input.id);
  }

  const ticket: Ticket = {
    id: input.id,
    title: input.title,
    description: input.description,
    link: input.link,
  };

  scope.tickets.push(ticket);
  await saveScopeData(scope);
  return ticket;
}

export async function removeTicket(ticketId: string, scopeId?: string): Promise<void> {
  const scope = await getScopeData(scopeId);
  const index = scope.tickets.findIndex((t) => t.id === ticketId);
  if (index === -1) {
    throw new TicketNotFoundError(ticketId);
  }
  scope.tickets.splice(index, 1);
  await saveScopeData(scope);
}

export async function listTickets(scopeId?: string): Promise<Ticket[]> {
  const scope = await getScopeData(scopeId);
  return scope.tickets;
}

export async function getTicket(ticketId: string, scopeId?: string): Promise<Ticket> {
  const scope = await getScopeData(scopeId);
  const ticket = scope.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw new TicketNotFoundError(ticketId);
  }
  return ticket;
}
