/**
 * `derivePrContent` — pure helper that produces sensible default title +
 * body for a sprint's PR / MR.
 *
 * The CLI / TUI is the seam where the user can edit these before the
 * chain launches; this helper just provides a starting point that's
 * useful when the user takes the defaults.
 *
 * Body shape (markdown):
 *
 *   # <sprint name>
 *
 *   ## Tickets    (omitted when no tickets exist)
 *   - <ticket title>
 *   - …
 *
 *   ## Tasks      (omitted when no done tasks exist)
 *   - <task name>
 *   - …
 *
 *   — sprint id: `<sprint id>`
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';

export interface DerivedPrContent {
  readonly title: string;
  readonly body: string;
}

export function derivePrContent(sprint: Sprint, tasks: readonly Task[]): DerivedPrContent {
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

  sections.push(`— sprint id: \`${sprint.id}\``);

  return { title: sprint.name, body: sections.join('\n\n') };
}
