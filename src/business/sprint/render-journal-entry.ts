import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Render a single task-attempt section into the append-only `<sprintDir>/progress.md`
 * journal (audit-[07]). Pure — same inputs always produce the same string.
 *
 * Section shape — the metadata block carries the verdict / round / duration / commit at a
 * glance; below it, one subsection per non-empty signal kind surfaces the actual signal text.
 * Empty subsections are dropped entirely (no heading-with-no-bullets):
 *
 *   ## Task: <task name> — Attempt <N>
 *
 *   _<iso timestamp>_
 *
 *   <outcome paragraph>
 *
 *   - Verdict: <pass | blocked>
 *   - Round: <round N of M>
 *   - Duration: <elapsed>
 *   - Commit: <sha-or-em-dash>
 *
 *   ### Changes
 *   - <change 1>
 *
 *   ### Decisions
 *   - <decision 1>
 *
 *   ### Learnings
 *   - <learning 1>
 *
 *   ### Notes
 *   - <note 1>
 *
 * The leading newline + trailing newline make the section concatenate cleanly when appended
 * to a non-empty journal — readers see a blank line separating consecutive sections.
 *
 * Lists are emitted verbatim — dedupe / trim happen at the leaf-call site so the renderer
 * stays a pure formatter.
 *
 * @public
 */
export interface JournalEntryInput {
  readonly taskName: string;
  readonly attemptN: number;
  readonly verdict: 'pass' | 'blocked';
  /** Free-text reason or short prose paragraph. */
  readonly outcome: string;
  readonly roundN: number;
  readonly totalRounds: number;
  /** Total round duration in milliseconds. `undefined` → renders as `—`. */
  readonly durationMs?: number;
  /** Deduped change-signal bodies emitted across the attempt. Empty → no `### Changes` subsection. */
  readonly changes: readonly string[];
  /** Deduped decision-signal bodies emitted across the attempt. Empty → no `### Decisions` subsection. */
  readonly decisions: readonly string[];
  /** Deduped learning-signal bodies emitted across the attempt. Empty → no `### Learnings` subsection. */
  readonly learnings: readonly string[];
  /** Deduped note-signal bodies emitted across the attempt. Empty → no `### Notes` subsection. */
  readonly notes: readonly string[];
  /** Commit sha that landed (truncated). Missing when the attempt blocked. */
  readonly commitSha?: string;
  readonly timestamp: IsoTimestamp;
}

const EM_DASH = '—';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Human-readable duration. Mirrors the `render-round-outcome` formatter. */
const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return EM_DASH;
  if (ms < 0) return `${String(ms)}ms`;
  if (ms < MS_PER_SECOND) return `${String(ms)}ms`;
  if (ms < MS_PER_MINUTE) {
    return `${String(Math.floor(ms / MS_PER_SECOND))}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(minutes)}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
};

const SHA_DISPLAY_LENGTH = 7;

/**
 * Append a `### <heading>` subsection with one bullet per entry. No-op when the list is empty
 * — the journal omits the heading entirely so readers don't see hollow placeholders.
 */
const appendSubsection = (lines: string[], heading: string, entries: readonly string[]): void => {
  if (entries.length === 0) return;
  lines.push(`### ${heading}`);
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  lines.push('');
};

/**
 * Render one journal section. The string is intended to be appended verbatim to an existing
 * journal file via the `AppendFile` port — it carries its own leading + trailing whitespace
 * so consecutive sections never abut.
 *
 * @public
 */
export const renderJournalEntry = (input: JournalEntryInput): string => {
  const sha = input.commitSha !== undefined ? input.commitSha.slice(0, SHA_DISPLAY_LENGTH) : EM_DASH;
  const outcome = input.outcome.trim().length > 0 ? input.outcome.trim() : '_(no outcome paragraph)_';
  const lines: string[] = [];
  lines.push('');
  lines.push(`## Task: ${input.taskName} — Attempt ${String(input.attemptN)}`);
  lines.push('');
  lines.push(`_${String(input.timestamp)}_`);
  lines.push('');
  lines.push(outcome);
  lines.push('');
  lines.push(`- Verdict: ${input.verdict}`);
  lines.push(`- Round: round ${String(input.roundN)} of ${String(input.totalRounds)}`);
  lines.push(`- Duration: ${formatDuration(input.durationMs)}`);
  lines.push(`- Commit: ${sha}`);
  lines.push('');
  appendSubsection(lines, 'Changes', input.changes);
  appendSubsection(lines, 'Decisions', input.decisions);
  appendSubsection(lines, 'Learnings', input.learnings);
  appendSubsection(lines, 'Notes', input.notes);
  return lines.join('\n');
};

/**
 * Render the sprint header — the single block written once at sprint creation. Header carries
 * invariant metadata only (no ticket list); the canonical ticket source is `sprint.json`.
 *
 * @public
 */
export const renderJournalSprintHeader = (input: {
  readonly sprintName: string;
  readonly sprintId: string;
  readonly createdAt: IsoTimestamp;
}): string => {
  const lines: string[] = [];
  lines.push(`# Sprint: ${input.sprintName}`);
  lines.push('');
  lines.push(`- id: ${input.sprintId}`);
  lines.push(`- created: ${String(input.createdAt)}`);
  lines.push('');
  return lines.join('\n');
};

/**
 * Render a status-transition separator line. Status transitions (active / review / done)
 * append one of these between task-attempt sections so the operator sees the lifecycle in
 * chronological order. Pure.
 *
 * @public
 */
export const renderJournalSeparator = (input: {
  readonly status: 'activated' | 'review' | 'closed';
  readonly at: IsoTimestamp;
}): string => {
  const label =
    input.status === 'activated' ? 'activated' : input.status === 'review' ? 'transitioned to review' : 'closed';
  return `\n---\n\n_Sprint ${label} at ${String(input.at)}_\n\n`;
};
