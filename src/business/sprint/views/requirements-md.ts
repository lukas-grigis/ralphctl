import type { Sprint } from '@src/domain/entity/sprint.ts';

/**
 * Pure renderer — turn the approved-tickets section of a `Sprint` aggregate into a markdown
 * document a human or another tool can read outside ralphctl. Only `approved` tickets are
 * included; pending tickets have no requirements yet, and surfacing them would imply the export
 * is "ready" when it's not.
 *
 * v1's `ExportRequirementsUseCase` read a separate `requirements.json` aggregate from disk; v2's
 * sprint is a single source of truth, so we render directly from the in-memory aggregate. No
 * derived JSON file exists to drift from.
 */
export const renderSprintRequirementsMarkdown = (sprint: Sprint): string => {
  const approved = sprint.tickets.filter((t) => t.status === 'approved');

  const lines: string[] = [];
  lines.push(`# ${sprint.name} — Requirements`);
  lines.push('');
  lines.push(`- Sprint id: \`${String(sprint.id)}\``);
  lines.push(`- Slug: \`${String(sprint.slug)}\``);
  lines.push(`- Status: ${sprint.status}`);
  lines.push(`- Approved tickets: ${String(approved.length)} of ${String(sprint.tickets.length)}`);
  lines.push('');

  if (approved.length === 0) {
    lines.push('_(no approved tickets — run `ralphctl sprint refine` first)_');
    lines.push('');
    return lines.join('\n');
  }

  for (const ticket of approved) {
    lines.push(`## ${ticket.title}`);
    lines.push('');
    lines.push(`- ID: \`${String(ticket.id)}\``);
    if (ticket.link !== undefined) lines.push(`- Link: ${String(ticket.link)}`);
    if (ticket.description !== undefined) {
      lines.push('');
      lines.push(ticket.description);
    }
    lines.push('');
    lines.push(ticket.requirements);
    lines.push('');
  }

  return lines.join('\n');
};
