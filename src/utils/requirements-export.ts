import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Sprint, Ticket } from '@src/schemas/index.ts';
import { ensureDir } from '@src/utils/storage.ts';

/**
 * Format requirements as a markdown document.
 */
function formatRequirementsMarkdown(sprint: Sprint): string {
  const lines: string[] = [];

  lines.push(`# Sprint Requirements: ${sprint.name}`);
  lines.push('');
  lines.push(`Sprint ID: ${sprint.id}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Status: ${sprint.status}`);

  if (sprint.tickets.length === 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('_No tickets in this sprint._');
    return lines.join('\n') + '\n';
  }

  for (const ticket of sprint.tickets) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(formatTicketSection(ticket));
  }

  return lines.join('\n') + '\n';
}

function formatTicketSection(ticket: Ticket): string {
  const lines: string[] = [];

  lines.push(`## ${ticket.projectName} - ${ticket.title}`);
  lines.push('');
  lines.push(`**Ticket ID:** ${ticket.id}`);
  lines.push(`**Status:** ${ticket.requirementStatus}`);

  if (ticket.link) {
    lines.push(`**Link:** ${ticket.link}`);
  }

  lines.push('');
  lines.push('### Requirements');
  lines.push('');
  lines.push(ticket.requirements ?? '_No requirements defined_');

  return lines.join('\n');
}

/**
 * Export sprint requirements to a markdown file.
 */
export async function exportRequirementsToMarkdown(sprint: Sprint, outputPath: string): Promise<void> {
  const content = formatRequirementsMarkdown(sprint);
  await ensureDir(dirname(outputPath));
  await writeFile(outputPath, content, 'utf-8');
}
