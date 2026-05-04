/**
 * Sprint requirements aggregate — the canonical JSON shape consolidating
 * **only approved** ticket requirements at the sprint level.
 *
 * Auto-maintained at `<sprintDir>/requirements.json` by the refine flow
 * (re-derived from `sprint.json` after every per-ticket save) and copied
 * verbatim into `<sprintDir>/planning/requirements.json` at planning
 * folder build time so the plan AI reads requirements from its own cwd
 * rather than crawling the filesystem.
 *
 * Tickets without `requirementStatus === 'approved'` are excluded.
 * Re-deriving on every save means the aggregate cannot drift from the
 * sprint aggregate root — there is no separate persistence step that
 * can fall out of sync.
 *
 * The shape carries the sprint-level metadata the `sprint requirements`
 * markdown export needs (project, affected repos, sprint name) so the
 * markdown rendering reads exclusively from this aggregate. JSON stays
 * the only stored source of truth.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';

export interface SprintRequirementsAggregate {
  readonly sprintId: string;
  readonly sprintName: string;
  readonly projectName: string;
  readonly affectedRepositories: readonly string[];
  readonly generatedAt: string;
  readonly tickets: readonly SprintRequirementsTicketEntry[];
}

export interface SprintRequirementsTicketEntry {
  readonly ticketId: string;
  readonly title: string;
  readonly description?: string;
  readonly link?: string;
  readonly requirements: string;
}

/**
 * Build the JSON aggregate from a sprint. Pure — `now` is injected so
 * tests can freeze time. Filters to `requirementStatus === 'approved'`
 * and emits ticket entries in the same order they appear on the sprint.
 */
export function buildSprintRequirementsAggregate(sprint: Sprint, now: Date = new Date()): SprintRequirementsAggregate {
  return {
    sprintId: String(sprint.id),
    sprintName: sprint.name,
    projectName: String(sprint.projectName),
    affectedRepositories: sprint.affectedRepositories.map((p) => String(p)),
    generatedAt: now.toISOString(),
    tickets: sprint.tickets
      .filter((t) => t.requirementStatus === 'approved')
      .map((t) => ({
        ticketId: String(t.id),
        title: t.title,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.link !== undefined ? { link: t.link } : {}),
        requirements: t.requirements ?? '',
      })),
  };
}

/** Stringify the aggregate with stable indentation suitable for `requirements.json`. */
export function serialiseSprintRequirementsAggregate(agg: SprintRequirementsAggregate): string {
  return `${JSON.stringify(agg, null, 2)}\n`;
}

/**
 * Render the aggregate as the user-facing markdown the `sprint
 * requirements` command exports. Pure — operates on the JSON shape so
 * the markdown is always a faithful projection of the canonical file.
 */
export function renderSprintRequirementsMarkdown(agg: SprintRequirementsAggregate): string {
  const lines: string[] = [];
  lines.push(`# Requirements — ${agg.sprintName}`);
  lines.push('');
  lines.push(`- Sprint id: \`${agg.sprintId}\``);
  lines.push(`- Project: ${agg.projectName}`);
  if (agg.affectedRepositories.length > 0) {
    lines.push('- Affected repositories:');
    for (const repo of agg.affectedRepositories) {
      lines.push(`  - \`${repo}\``);
    }
  }
  lines.push('');

  if (agg.tickets.length === 0) {
    lines.push('_(no approved ticket requirements yet — run `ralphctl sprint refine`)_');
    lines.push('');
    return lines.join('\n');
  }

  for (const ticket of agg.tickets) {
    lines.push(`## ${ticket.title}`);
    lines.push('');
    lines.push(`- ID: \`${ticket.ticketId}\``);
    if (ticket.link !== undefined) lines.push(`- Link: ${ticket.link}`);
    lines.push('');
    if (ticket.description !== undefined && ticket.description.length > 0) {
      lines.push('### Description');
      lines.push('');
      lines.push(ticket.description);
      lines.push('');
    }
    lines.push('### Requirements');
    lines.push('');
    lines.push(ticket.requirements.length > 0 ? ticket.requirements : '_(empty)_');
    lines.push('');
  }
  return lines.join('\n');
}
