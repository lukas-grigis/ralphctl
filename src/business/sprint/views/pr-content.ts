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
 *   ## Related issues  (omitted when neither tickets nor tasks carry external refs)
 *   - Closes #123
 *   - Closes !456
 *
 * "Related issues" bullets use the `Closes <ref>` form GitHub and GitLab both recognise for
 * auto-close on merge. Refs are gathered from both `Ticket.externalRef` (singular, set at
 * ticket-creation time) and `Task.externalRefs[]` (plural, inherited from the originating
 * ticket at plan time) — the merged list is trimmed and deduped via `normalizeRefs` so a ref
 * that appears on both a ticket and its derived task does not show twice. The PR body is
 * deliberately ralphctl-agnostic: no sprint id, no harness footer.
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

  const orderedRefs = normalizeRefs([
    ...sprint.tickets.map((t) => t.externalRef ?? ''),
    ...tasks.flatMap((t) => t.externalRefs ?? []),
  ]);
  if (orderedRefs.length > 0) {
    const refLines = orderedRefs.map((r) => `- Closes ${r}`).join('\n');
    sections.push(`## Related issues\n${refLines}`);
  }

  return { title: sprint.name, body: sections.join('\n\n') };
};
