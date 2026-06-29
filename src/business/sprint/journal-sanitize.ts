/**
 * Forgery-safety helpers shared by every renderer that writes into `<sprintDir>/progress.md`.
 *
 * The journal's column-0 `## Task: ` lines are load-bearing structure: they are the section
 * delimiter `capProgressBody` splits and attributes on, and the next generator's cross-attempt
 * memory. Any renderer that inlines AI- or planner-authored text (task names, blocked reasons,
 * outcome prose, signal bodies) MUST route it through these helpers so a quoted heading or a
 * newline-bearing name can never FORGE or break a section boundary.
 *
 * Pure — no I/O.
 */

/**
 * Collapse newlines / control characters in a single-line slot (a section-header task name, a
 * derived-table cell). A newline-bearing value would otherwise let text fabricate or break a
 * structural boundary in a slot the journal treats as one line.
 */
export const sanitizeInline = (text: string): string => text.replace(/[\r\n\t\v\f]+/g, ' ').trim();

/**
 * Neutralize AI-controlled prose so no line can start a Markdown heading at column 0. Heading-shaped
 * lines are indented two spaces, which renders fine as prose and makes a structural match at `^##`
 * impossible — a critique or signal body quoting `## Task: other — Attempt 1` verbatim cannot forge
 * a section boundary.
 */
export const neutralizeProseHeadings = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line.startsWith('#') ? `  ${line}` : line))
    .join('\n');
