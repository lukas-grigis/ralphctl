/**
 * Plain-text formatters for sprint-shaped output. ANSI colors only —
 * never emoji. Functions in this module are pure; they take a domain
 * entity and return the rendered string. Caller writes to stdout.
 */
import * as c from 'colorette';

import type { Sprint, SprintStatus } from '../../../domain/entities/sprint.ts';

const STATUS_COLOR: Record<SprintStatus, (s: string) => string> = {
  draft: c.yellow,
  active: c.green,
  closed: c.gray,
};

export function formatSprintStatus(status: SprintStatus): string {
  return STATUS_COLOR[status](status);
}

/** Single-line summary used by `sprint list`. */
export function formatSprintLine(sprint: Sprint): string {
  const id = c.dim(sprint.id);
  const name = c.bold(sprint.name);
  const status = formatSprintStatus(sprint.status);
  const ticketCount = c.dim(`${String(sprint.tickets.length)} ticket(s)`);
  return `${status.padEnd(16)} ${id}  ${name}  ${ticketCount}`;
}

/** Multi-line card used by `sprint show` / `sprint create` confirmation. */
export function formatSprintCard(sprint: Sprint): string {
  const lines: string[] = [];
  lines.push(c.bold(sprint.name));
  lines.push(`  ${c.dim('id      ')} ${sprint.id}`);
  lines.push(`  ${c.dim('status  ')} ${formatSprintStatus(sprint.status)}`);
  lines.push(`  ${c.dim('created ')} ${sprint.createdAt}`);
  if (sprint.activatedAt) {
    lines.push(`  ${c.dim('started ')} ${sprint.activatedAt}`);
  }
  if (sprint.closedAt) {
    lines.push(`  ${c.dim('closed  ')} ${sprint.closedAt}`);
  }
  if (sprint.branch) {
    lines.push(`  ${c.dim('branch  ')} ${sprint.branch}`);
  }
  lines.push(`  ${c.dim('tickets ')} ${String(sprint.tickets.length)}`);
  return lines.join('\n');
}

export function formatTicketsTable(sprint: Sprint): string {
  if (sprint.tickets.length === 0) return c.dim('  (no tickets)');
  const rows = sprint.tickets.map((t) => {
    const status = t.requirementStatus === 'approved' ? c.green('approved') : c.yellow('pending ');
    return `  ${c.dim(t.id)}  ${status}  ${t.title}`;
  });
  return rows.join('\n');
}
