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
  // Split on `---` lines that are alone on their line (no surrounding text).
  const blocks = text.split(/^---\s*$/m);
  const rounds: FeedbackRound[] = [];
  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (trimmedBlock.length === 0) continue;
    const lines = trimmedBlock.split('\n');
    let index: number | undefined;
    const bodyLines: string[] = [];
    let pastMarker = false;
    for (const line of lines) {
      const headingMatch = ROUND_HEADING_RE.exec(line.trim());
      if (headingMatch !== null && index === undefined) {
        index = Number(headingMatch[1]);
        continue;
      }
      if (line.trim() === MARKER_COMMENT) {
        pastMarker = true;
        continue;
      }
      if (pastMarker) bodyLines.push(line);
      else if (line.trim().length > 0 && index !== undefined && !line.trim().startsWith('<!--')) {
        // Body content present BEFORE the marker comment (e.g. user edited above the marker).
        // Treat all post-heading non-comment lines as body.
        bodyLines.push(line);
      }
    }
    if (index === undefined) continue;
    const body = bodyLines.join('\n').trim();
    rounds.push({ index, body, raw: trimmedBlock });
  }
  return rounds;
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
