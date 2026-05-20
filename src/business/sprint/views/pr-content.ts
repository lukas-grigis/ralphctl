import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

export interface DerivedPrContent {
  readonly title: string;
  readonly body: string;
}

/**
 * Pure helper — produce sensible default title + body for a sprint's PR / MR.
 *
 * The CLI / TUI is the seam where the user can edit these before the chain launches; this
 * helper just provides a starting point that's useful when the user takes the defaults.
 *
 * Body shape (markdown):
 *
 *   # <sprint name>
 *
 *   ## Tickets         (omitted when no tickets exist)
 *   - <ticket title>
 *   - …
 *
 *   ## Tasks           (omitted when no done tasks exist)
 *   - <task name>
 *   - …
 *
 *   ## Related issues  (omitted when no ticket carries an externalRef)
 *   - Closes #123
 *   - Closes !456
 *
 *   — sprint id: `<sprint id>`
 *
 * "Related issues" bullets use the `Closes <ref>` form GitHub and GitLab both recognise for
 * auto-close on merge. Refs are trimmed and deduped via `normalizeRefs` so a sprint that
 * collected the same issue ref on multiple tickets does not show it twice.
 */
export const derivePrContent = (sprint: Sprint, tasks: readonly Task[]): DerivedPrContent => {
  const sections: string[] = [`# ${sprint.name}`];

  if (sprint.tickets.length > 0) {
    const ticketLines = sprint.tickets.map((t) => `- ${t.title}`).join('\n');
    sections.push(`## Tickets\n${ticketLines}`);
  }

  const doneTasks = tasks.filter((t) => t.status === 'done');
  if (doneTasks.length > 0) {
    const taskLines = doneTasks.map((t) => `- ${t.name}`).join('\n');
    sections.push(`## Tasks\n${taskLines}`);
  }

  const orderedRefs = normalizeRefs(sprint.tickets.map((t) => t.externalRef ?? ''));
  if (orderedRefs.length > 0) {
    const refLines = orderedRefs.map((r) => `- Closes ${r}`).join('\n');
    sections.push(`## Related issues\n${refLines}`);
  }

  sections.push(`— sprint id: \`${String(sprint.id)}\``);

  return { title: sprint.name, body: sections.join('\n\n') };
};
