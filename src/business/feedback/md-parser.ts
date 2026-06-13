/**
 * Parse `feedback.md` into a list of feedback rounds. Pure: takes a string, returns a list.
 *
 * On-disk shape:
 *
 *     # Feedback
 *
 *     <!-- Each round below is separated by a `---` line. -->
 *
 *     ## Round 1
 *
 *     <!-- write your feedback below this line, or leave empty to end review -->
 *     fix the foo bug in baz.ts
 *     ---
 *
 *     ## Round 2
 *
 *     <!-- write your feedback below this line, or leave empty to end review -->
 *     ---
 *
 * The first round (the implicit "## Round 1" block) holds the user's feedback for the first
 * apply-feedback turn. Subsequent rounds the harness appends after each AI turn; each new
 * round opens with a marker comment for the user to write under.
 *
 * Termination: a round's body is "empty" — and thus a termination round — when the only
 * non-blank content is the marker comment. Two ways to terminate:
 *   1. The current round body is empty.
 *   2. The current round body equals the previous round body (user re-saved without changes).
 */

const ROUND_HEADING_RE = /^##\s+Round\s+(\d+)\s*$/;
const MARKER_COMMENT = '<!-- write your feedback below this line, or leave empty to end review -->';

export interface FeedbackRound {
  /** 1-based round index parsed from `## Round N`. */
  readonly index: number;
  /** Body text under the marker comment (trimmed). Empty string when the round is empty. */
  readonly body: string;
  /** Raw block for round-equality checks (includes heading + marker + body). */
  readonly raw: string;
}

export const parseFeedbackMd = (text: string): readonly FeedbackRound[] => {
  // Split into rounds by the `## Round N` heading lines — NOT by `---` separators. A user's
  // pasted feedback can legitimately contain a bare `---` line (markdown rule, YAML frontmatter,
  // a diff hunk header): splitting on `---` would cut that round in two and silently drop the
  // half after the rule. The heading is harness-controlled, so it is the reliable round boundary.
  // The harness writes a trailing `---` separator after each round; we strip only that trailing
  // separator from each block so it never leaks into the body.
  const lines = text.split('\n');
  const rounds: FeedbackRound[] = [];

  let current: { index: number; lines: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const raw = current.lines.join('\n').trim();
    const body = extractBody(current.lines);
    rounds.push({ index: current.index, body, raw });
    current = undefined;
  };

  for (const line of lines) {
    const headingMatch = ROUND_HEADING_RE.exec(line.trim());
    if (headingMatch !== null) {
      flush();
      current = { index: Number(headingMatch[1]), lines: [line] };
      continue;
    }
    if (current !== undefined) current.lines.push(line);
  }
  flush();

  return rounds;
};

/**
 * Pull the body text out of one round's lines. The body is everything after the marker comment;
 * if a user edited above the marker, post-heading non-comment lines also count. A single trailing
 * harness-written `---` separator line is stripped, but a `---` line INSIDE the body is preserved
 * verbatim (the whole point — see {@link parseFeedbackMd}).
 */
const extractBody = (roundLines: readonly string[]): string => {
  // Drop a single trailing `---` separator line (plus any trailing blanks after it).
  const lines = [...roundLines];
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (lines.length > 0 && /^---\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop();

  const bodyLines: string[] = [];
  let pastMarker = false;
  let seenHeading = false;
  for (const line of lines) {
    if (!seenHeading && ROUND_HEADING_RE.test(line.trim())) {
      seenHeading = true;
      continue;
    }
    if (line.trim() === MARKER_COMMENT) {
      pastMarker = true;
      continue;
    }
    if (pastMarker) bodyLines.push(line);
    else if (line.trim().length > 0 && seenHeading && !line.trim().startsWith('<!--')) {
      // Body content present BEFORE the marker comment (user edited above the marker).
      bodyLines.push(line);
    }
  }
  return bodyLines.join('\n').trim();
};

/** A round is a termination round when its body is empty after trimming. */
export const isEmptyRound = (round: FeedbackRound): boolean => round.body.length === 0;

/**
 * Termination check used by the review-loop: end the loop when the current round is empty OR
 * its body matches the immediately-prior round (user re-saved without changes).
 */
export const isTerminationRound = (current: FeedbackRound, previous: FeedbackRound | undefined): boolean => {
  if (isEmptyRound(current)) return true;
  if (previous === undefined) return false;
  return current.body === previous.body;
};

/** Render the heading + marker for a fresh round. Used by the harness when appending. */
export const renderEmptyRound = (index: number): string => `## Round ${String(index)}\n\n${MARKER_COMMENT}\n\n`;

/** Render the round-separator line. */
export const ROUND_SEPARATOR = '---';

export { MARKER_COMMENT };
