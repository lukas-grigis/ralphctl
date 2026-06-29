import { sanitizeInline } from '@src/business/sprint/journal-sanitize.ts';

/**
 * Structural primitives for `<sprintDir>/progress.md` — the append-only sprint journal. Shared by
 * the renderer (`render-journal-entry.ts`), the inline-excerpt cap (`cap-progress.ts`), the
 * regenerate-in-place write path (`progress-journal.ts`), and the quarantine-pointer leaf so every
 * producer and consumer agrees on ONE definition of the section boundary and the lifecycle
 * breadcrumb shapes.
 *
 * The journal is a header band (everything before the first `## Task: ` line) followed by one
 * append-only section per settled attempt. Pure — no I/O.
 */

/**
 * Start-of-line marker for a task-attempt section. The renderer GUARANTEES no AI-controlled line
 * reaches column 0 starting with `#` (see `journal-sanitize.ts`), so a quoted `## Task:` inside a
 * critique cannot forge a boundary. A POSITIVE LOOKAHEAD never consumes characters, so splitting on
 * it keeps every section's own leading `## Task:` line and the pieces concatenate back to the input.
 */
const ATTEMPT_SECTION_DELIMITER = /^(?=## Task: )/m;

/**
 * Suffix appended to every section header line to embed the STABLE task id:
 * `## Task: <name> — Attempt <N> · id:<taskId>`. The id rides AFTER the harness-controlled attempt
 * number, so AI-/planner-authored task names (which sit before ` — Attempt <N>`) can never reach
 * past it — the trailing ` · id:<taskId>` is always the harness's, which is what makes
 * {@link sectionBelongsToTask} forgery-safe. The id is a UUIDv7 (`[0-9a-f-]` only), so the `·`
 * separator is unambiguous against prose.
 */
const JOURNAL_TASK_ID_MARKER = ' · id:';

/** Render the forgery-safe section header line for one attempt. */
export const renderSectionHeader = (taskName: string, attemptN: number, taskId: string): string =>
  `## Task: ${sanitizeInline(taskName)} — Attempt ${String(attemptN)}${JOURNAL_TASK_ID_MARKER}${taskId}`;

/**
 * True when `section` is an attempt section belonging to `taskId`. Matches the harness-controlled
 * id token at the END of the section's first line — never the name — so identical task names or a
 * mid-sprint rename can neither collide nor orphan a task's earlier sections.
 */
export const sectionBelongsToTask = (section: string, taskId: string): boolean => {
  const firstLine = section.split('\n', 1)[0] ?? '';
  return firstLine.endsWith(`${JOURNAL_TASK_ID_MARKER}${taskId}`);
};

interface JournalSplit {
  /** Everything before the first `## Task: ` line — sprint identity, derived state, lifecycle separators. */
  readonly headerBand: string;
  /** One entry per attempt section, each still carrying its own leading `## Task: ` line, in order. */
  readonly sections: readonly string[];
}

/**
 * Split a journal body into its header band and its per-attempt sections. A body with no attempt
 * sections (header-only — the first task of a sprint) returns `{ headerBand: body, sections: [] }`.
 */
export const splitJournal = (body: string): JournalSplit => {
  const pieces = body.split(ATTEMPT_SECTION_DELIMITER);
  // `split` with a lookahead never consumes characters, so the first piece is the header band and
  // the rest are sections. `pieces` is never empty.
  const [headerBand = '', ...sections] = pieces;
  return { headerBand, sections };
};

// Lifecycle separators come from `renderJournalSeparator`: `_Sprint <label> at <iso>_`.
const SEPARATOR_CAPTION = /^_Sprint .+ at .+_$/;
// Quarantine pointers come from the quarantine-blocked-diff leaf — always lead with `_Task ` and
// carry this exact phrase, so a blocked-reason that merely mentions the words can't match.
const QUARANTINE_POINTER = /^_Task .*rejected diff quarantined to git stash/;

/**
 * Extract the lifecycle / recovery breadcrumbs from a slice of journal text — status-transition
 * separators (`---` + `_Sprint … at …_`) and quarantine-recovery pointers. Returns each as a
 * normalized block (the separator rule is re-synthesised above its caption) so callers can PIN them
 * into the always-kept header band. Recognises ONLY these two shapes, so re-running it over an
 * already-regenerated header band (which also holds derived `## Status` / `## Tasks` headings) is
 * idempotent — the derived headings are never mistaken for breadcrumbs.
 */
export const extractLifecycleBreadcrumbs = (text: string): readonly string[] => {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (SEPARATOR_CAPTION.test(trimmed)) out.push(`---\n\n${trimmed}`);
    else if (QUARANTINE_POINTER.test(trimmed)) out.push(trimmed);
  }
  return out;
};

/** Join breadcrumb blocks into a journal slice with the journal's blank-line spacing. */
export const renderBreadcrumbBand = (breadcrumbs: readonly string[]): string =>
  breadcrumbs.length === 0 ? '' : `\n${breadcrumbs.map((b) => `${b}\n`).join('\n')}`;

/**
 * Render the quarantine-recovery pointer appended to the journal when a blocked task's rejected diff
 * is stashed. Leads with `_Task ` and carries the exact `rejected diff quarantined to git stash`
 * phrase {@link extractLifecycleBreadcrumbs} recognises, so the cap can PIN the pointer into the
 * always-kept header band even when the blocked task's own section is elided from the inline excerpt.
 * The task name is collapsed to one line so it can never break the breadcrumb across lines.
 *
 * @public
 */
export const renderQuarantineBreadcrumb = (taskName: string, stashMessage: string): string =>
  `\n_Task ${sanitizeInline(taskName)}: rejected diff quarantined to git stash — recover via \`git stash list\` (message: \`${stashMessage}\`)._\n`;
