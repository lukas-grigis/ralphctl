import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt, AttemptWarning } from '@src/domain/entity/attempt.ts';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

export interface DerivedPrContent {
  readonly title: string;
  readonly body: string;
}

/** One-line human detail tail for a PR-body warning bullet. Mirrors the TUI attempt-card copy. */
const warningDetail = (w: AttemptWarning): string => {
  switch (w.kind) {
    case 'budget-exhausted':
      return `turn budget exhausted (${String(w.turnsUsed)}/${String(w.turnBudget)} turns)`;
    case 'plateau':
      return w.dimensions.length > 0 ? `evaluator plateaued on: ${w.dimensions.join(', ')}` : 'evaluator plateaued';
    case 'malformed':
      return w.detail.trim().length > 0
        ? `evaluator output malformed (${w.detail.trim()})`
        : 'evaluator output malformed';
    case 'verify-failed': {
      const exit = w.exitCode !== null ? `exit ${String(w.exitCode)}` : 'no exit code';
      return w.stderr.trim().length > 0
        ? `post-task verify red (${exit}: ${w.stderr.trim()})`
        : `post-task verify red (${exit})`;
    }
    case 'crashed':
      return w.detail.trim().length > 0
        ? `process killed (watchdog/crash): ${w.detail.trim()}`
        : 'process killed (watchdog/crash)';
  }
};

const lastAttempt = (task: Task): Attempt | undefined => task.attempts[task.attempts.length - 1];

/**
 * Render the `## Completed with warnings` PR-body section — one bullet per done task whose
 * FINAL attempt carries an {@link AttemptWarning}. Shared by both PR-body paths (the
 * template-derived fallback below and the harness-side append after the AI authors the body) so
 * the warnings copy stays identical. Returns the empty string when no task is flagged — callers
 * must emit no header for an empty section.
 */
export const renderWarningsSection = (tasks: readonly Task[]): string => {
  const flagged = tasks
    .map((t) => ({ name: t.name, warning: t.status === 'done' ? lastAttempt(t)?.warning : undefined }))
    .filter((e): e is { name: string; warning: AttemptWarning } => e.warning !== undefined);
  if (flagged.length === 0) return '';
  const lines = flagged.map((e) => `- ${e.name} — ${warningDetail(e.warning)}`).join('\n');
  return `## Completed with warnings\n${lines}`;
};

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
 *   ## Tasks                    (omitted when no done tasks exist)
 *   - <task name>
 *   - …
 *
 *   ## Completed with warnings  (omitted when no done task carries a final-attempt warning)
 *   - <task name> — <warning detail>
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

  // Honesty section — surface tasks that settled `done` but carry a final-attempt warning so the
  // reviewer isn't told a flagged task "completed" without qualification. Empty → no header.
  const warnings = renderWarningsSection(tasks);
  if (warnings.length > 0) sections.push(warnings);

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
