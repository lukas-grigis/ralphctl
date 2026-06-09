/**
 * Cap the inlined `progress.md` body — bounding BREADTH across other tasks while preserving
 * the full DEPTH of the current task's own history.
 *
 * `progress.md` is sprint-wide and append-only: every settled task-attempt appends one
 * `## Task: <name> — Attempt <N>` section (see `renderJournalEntry` in
 * `business/sprint/render-journal-entry.ts`). Late in a long sprint the file holds dozens of
 * sections, so inlining the WHOLE body into every gen-eval prompt (generator and evaluator,
 * every round) grows token cost superlinearly while the marginal value of a 20-attempts-ago
 * sibling section is near zero.
 *
 * Three parts ride verbatim:
 *
 *   1. The header — everything before the first `## Task:` delimiter. That block carries the
 *      sprint name / id / created-at (`renderJournalSprintHeader`) plus any status-transition
 *      separators that precede the first attempt; it is small and invariant, so it always rides.
 *   2. EVERY section belonging to the current task (matched by name on the section's
 *      `## Task: <name> — Attempt` line). This is the depth that correctness demands: the
 *      current task's earlier attempts carry the warnings, escalations, and remedies the next
 *      attempt must honour, and they must never fall out of a recency window just because
 *      sibling tasks journaled in between.
 *   3. The last {@link RECENT_ATTEMPT_SECTIONS} OTHER-task sections — the recent cross-task
 *      decisions a generator must honour. Older sibling sections are elided.
 *
 * N is **3** for the sibling window: the immediately-prior critique already rides separately as
 * `<prior_critique>`, so the journal only needs to surface recent cross-task context; three keeps
 * the typical late-sprint inline body to a few KB. Elision is NEVER silent: each dropped run is
 * replaced in place by a one-line note stating how many sections were omitted and that the full
 * `progress.md` on disk (reachable via the `sprintDir` `--add-dir` mount) holds the complete
 * history — so the model knows it is looking at a window, and where to pull the rest. The cap
 * bounds what is *inlined*, never what is *recorded*.
 *
 * The delimiter is the literal start-of-line `## Task:` token the journal renderer emits for
 * every attempt section. We split on a positive-lookahead so each section keeps its own leading
 * `## Task:` line, then reassemble header + kept sections in original order. A body with no
 * sections (the first task of a sprint) passes through untouched.
 *
 * Pure — same input always produces the same output. No I/O.
 */

/** Last-N OTHER-task attempt sections kept when inlining `progress.md`. See module docstring. */
export const RECENT_ATTEMPT_SECTIONS = 3;

/** Start-of-line marker for a task-attempt section in `progress.md`. */
const ATTEMPT_DELIMITER = /^(?=## Task: )/m;

const elisionNote = (droppedCount: number): string =>
  `_${String(droppedCount)} earlier attempt section${droppedCount === 1 ? '' : 's'} omitted from this inline excerpt — read the full \`progress.md\` on disk for the complete history._\n\n`;

/**
 * Cap `body` to its header, ALL sections of `currentTaskName` (when supplied), and the last
 * {@link RECENT_ATTEMPT_SECTIONS} other-task attempt sections. Empty / whitespace-only input
 * returns the empty string. A body already within the cap is returned unchanged. Each elided
 * run of sections is replaced in place by a one-line note naming the omitted count.
 */
export const capProgressBody = (
  body: string,
  recentSections = RECENT_ATTEMPT_SECTIONS,
  currentTaskName?: string
): string => {
  if (body.trim().length === 0) return '';

  // split() with a lookahead delimiter never consumes characters, so the pieces concatenate
  // back to the original string. The first piece is the header (everything before the first
  // `## Task:`); the rest are one-per-attempt sections, each still carrying its `## Task:` line.
  const pieces = body.split(ATTEMPT_DELIMITER);
  if (pieces.length <= 1) return body; // no attempt sections yet — header-only, return as-is.

  const [header, ...sections] = pieces;

  // Depth guarantee: the current task's own sections are always kept, wherever they sit.
  const isCurrentTask = (section: string): boolean =>
    currentTaskName !== undefined && section.startsWith(`## Task: ${currentTaskName} — Attempt`);

  // Breadth bound: of the OTHER tasks' sections, keep only the most recent N.
  const otherIndexes = sections.flatMap((s, i) => (isCurrentTask(s) ? [] : [i]));
  const keptOtherIndexes = new Set(otherIndexes.slice(Math.max(0, otherIndexes.length - recentSections)));

  const keep = (i: number): boolean => isCurrentTask(sections[i] ?? '') || keptOtherIndexes.has(i);
  if (sections.every((_s, i) => keep(i))) return body; // already within the cap — untouched.

  // Reassemble in original order, replacing each maximal dropped run with one elision note so
  // the truncation is explicit at the exact point of omission.
  const parts: string[] = [header ?? ''];
  let droppedRun = 0;
  for (let i = 0; i < sections.length; i += 1) {
    if (keep(i)) {
      if (droppedRun > 0) {
        parts.push(elisionNote(droppedRun));
        droppedRun = 0;
      }
      parts.push(sections[i] ?? '');
    } else {
      droppedRun += 1;
    }
  }
  if (droppedRun > 0) parts.push(elisionNote(droppedRun));

  return parts.join('');
};
