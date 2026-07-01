import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import { neutralizeProseHeadings } from '@src/business/sprint/journal-sanitize.ts';
import { renderSectionHeader } from '@src/business/sprint/journal-structure.ts';

/**
 * Verdict the journal records for a settled task-attempt. Widened beyond the original
 * `pass | blocked` so the journal stops lying about non-passing exits that still settle `done`:
 *
 *  - `pass`              — verification ran clean; the attempt landed with no warning.
 *  - `pass-with-warning` — task settled `done` but the final attempt carries an
 *                          {@link JournalWarning} (budget / plateau / malformed / verify-failed).
 *  - `escalated`         — the attempt failed and the task is back `in_progress` because the
 *                          escalation policy retried (climbed a model rung or re-ran the same
 *                          model). The next attempt's generator will read this section.
 *  - `blocked`           — the task was blocked (own failure or upstream cascade).
 *
 * The verdict is read by BOTH humans and the next attempt's generator (the journal is inlined
 * into `<prior_progress>`), so `pass-with-warning` / `escalated` must never masquerade as `pass`.
 */
export type JournalVerdict = 'pass' | 'pass-with-warning' | 'escalated' | 'blocked';

/**
 * Structured warning carried into the journal entry — a flattened mirror of the domain
 * `AttemptWarning` so the renderer stays decoupled from the entity. The leaf projects the
 * latest attempt's warning into this shape; the renderer turns it into plain prose stating
 * what failed and on which dimensions.
 *
 *  - `kind`        — the warning discriminant (`budget-exhausted` / `plateau` / `malformed` /
 *                    `verify-failed` / `crashed`).
 *  - `detail`      — one-line human detail (malformed parse error, verify stderr head, crash
 *                    exit/signal text, …).
 *  - `dimensions`  — failed-criterion ids, present only for the `plateau` kind.
 *  - `turnsUsed` / `turnBudget` — present only for the `budget-exhausted` kind.
 */
export interface JournalWarning {
  readonly kind: 'budget-exhausted' | 'plateau' | 'malformed' | 'verify-failed' | 'crashed';
  readonly detail?: string;
  readonly dimensions?: readonly string[];
  readonly turnsUsed?: number;
  readonly turnBudget?: number;
}

/**
 * Model-ladder transition stamped by the escalation policy after a plateau / malformed retry.
 * When `from === to` the climb was a top-of-ladder same-model nudge rather than a rung bump —
 * the renderer states that explicitly so the next generator isn't misled into expecting a
 * stronger model.
 */
export interface JournalEscalation {
  readonly from: string;
  readonly to: string;
}

/**
 * Render a single task-attempt section into the append-only `<sprintDir>/progress.md`
 * journal (audit-[07]). Pure — same inputs always produce the same string.
 *
 * Section shape — the metadata block carries the verdict / round / duration / commit at a
 * glance; below it, one subsection per non-empty signal kind surfaces the actual signal text.
 * Empty subsections are dropped entirely (no heading-with-no-bullets):
 *
 *   ## Task: <task name> — Attempt <N> · id:<task id>
 *
 *   _<iso timestamp>_
 *
 *   <outcome paragraph>
 *
 *   - Verdict: <pass | pass-with-warning | escalated | blocked>
 *   - Round: <round N of M>
 *   - Duration: <elapsed>
 *   - Commit: <sha-or-em-dash>
 *
 *   ### Outcome detail        (only when a warning / escalation is present)
 *   - <plain-prose statement of what failed, on which dimensions, and the remedy applied>
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
 */
export interface JournalEntryInput {
  readonly taskName: string;
  /**
   * Stable task id, embedded in the section header as ` · id:<taskId>`. The cap matches the
   * "current task" depth guarantee on THIS id, not the name — so identical task names can't
   * collide and a mid-sprint rename can't orphan a task's earlier sections.
   */
  readonly taskId: string;
  readonly attemptN: number;
  readonly verdict: JournalVerdict;
  /** Free-text reason or short prose paragraph. */
  readonly outcome: string;
  readonly roundN: number;
  readonly totalRounds: number;
  /** Total round duration in milliseconds. `undefined` → renders as `—`. */
  readonly durationMs?: number;
  /**
   * Structured warning carried by the final attempt, when one is present. Drives the
   * `### Outcome detail` subsection. Absent on the clean-pass path.
   */
  readonly warning?: JournalWarning;
  /**
   * Model-ladder transition applied by the escalation policy after this attempt failed.
   * Present on the `escalated` verdict (and on a `pass-with-warning` where the prior failing
   * attempt triggered a climb). Absent when no escalation occurred.
   */
  readonly escalation?: JournalEscalation;
  /** Deduped change-signal bodies emitted across the attempt. Empty → no `### Changes` subsection. */
  readonly changes: readonly string[];
  /** Deduped decision-signal bodies emitted across the attempt. Empty → no `### Decisions` subsection. */
  readonly decisions: readonly string[];
  /** Deduped structured learnings emitted across the attempt. Empty → no `### Learnings` subsection. */
  readonly learnings: readonly LearningEntry[];
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
 * — the journal omits the heading entirely so readers don't see hollow placeholders. Interior
 * lines of multi-line entries are indented as Markdown list continuations, which doubles as the
 * heading-forgery neutralization (see {@link neutralizeProseHeadings} for why a column-0 `#`
 * from AI text must never reach the journal).
 */
const appendSubsection = (lines: string[], heading: string, entries: readonly string[]): void => {
  if (entries.length === 0) return;
  lines.push(`### ${heading}`);
  for (const entry of entries) {
    lines.push(`- ${entry.split('\n').join('\n  ')}`);
  }
  lines.push('');
};

/**
 * Append the `### Learnings` subsection. Each learning renders as a bold Insight bullet with
 * optional `Context:` / `Applies to:` sub-bullets (emitted only when the learning carries them),
 * so a human reads the structure fluently. No-op when there are no learnings.
 */
const appendLearningsSubsection = (lines: string[], entries: readonly LearningEntry[]): void => {
  if (entries.length === 0) return;
  lines.push('### Learnings');
  for (const entry of entries) {
    // Interior lines indent as list continuations — the same heading-forgery neutralization
    // appendSubsection applies (AI text must never land a column-0 `#`).
    lines.push(`- **${entry.text.split('\n').join('\n  ')}**`);
    if (entry.context !== undefined && entry.context.trim().length > 0) {
      lines.push(`  - Context: ${entry.context.trim().split('\n').join('\n    ')}`);
    }
    if (entry.appliesTo !== undefined && entry.appliesTo.trim().length > 0) {
      lines.push(`  - Applies to: ${entry.appliesTo.trim().split('\n').join('\n    ')}`);
    }
  }
  lines.push('');
};

/** ` (detail)` when a non-empty detail is present, else '' — shared by the malformed + crashed arms. */
const parenDetail = (detail: string | undefined): string =>
  detail !== undefined && detail.trim().length > 0 ? ` (${detail.trim()})` : '';

/**
 * One plain-prose sentence describing what the warning means for the next attempt. The journal
 * is the generator's cross-attempt memory, so this names the failure mode explicitly instead of
 * leaning on a glyph or jargon.
 */
const warningSentence = (warning: JournalWarning): string => {
  switch (warning.kind) {
    case 'budget-exhausted': {
      const turns =
        warning.turnsUsed !== undefined && warning.turnBudget !== undefined
          ? ` after exhausting the turn budget (${String(warning.turnsUsed)} of ${String(warning.turnBudget)} turns used)`
          : ' after exhausting the turn budget';
      return `The evaluator did not pass${turns}.`;
    }
    case 'plateau': {
      const dims =
        warning.dimensions !== undefined && warning.dimensions.length > 0
          ? ` on the same failed dimension${warning.dimensions.length === 1 ? '' : 's'}: ${warning.dimensions.join(', ')}`
          : '';
      return `The evaluator plateaued — two consecutive evaluations flagged the identical failure${dims}.`;
    }
    case 'malformed':
      return `The evaluator output could not be parsed${parenDetail(warning.detail)}.`;
    case 'verify-failed': {
      const detail =
        warning.detail !== undefined && warning.detail.trim().length > 0 ? `: ${warning.detail.trim()}` : '';
      return `The post-task verify script ran red after the commit${detail}.`;
    }
    case 'crashed':
      return `The AI process was killed (watchdog/crash) before finishing${parenDetail(warning.detail)}; the attempt was retried.`;
  }
};

/**
 * One plain-prose sentence describing the remedy applied after this attempt. Distinguishes a
 * model-rung climb from a top-of-ladder same-model retry so the next generator reads the truth.
 * A malformed exit retries on the same model WITHOUT touching the ladder (the projection layer
 * suppresses any stale escalation stamp on that path), so it gets its own honest sentence.
 */
const remedySentence = (
  verdict: JournalVerdict,
  escalation: JournalEscalation | undefined,
  warning: JournalWarning | undefined
): string | undefined => {
  if (escalation !== undefined) {
    return escalation.from === escalation.to
      ? `Remedy: retried the same model (${escalation.to}) — already at the top of the escalation ladder.`
      : `Remedy: escalated the generator model from ${escalation.from} to ${escalation.to}.`;
  }
  if (verdict === 'escalated' && warning?.kind === 'malformed') {
    return 'Remedy: retried on the same model — the evaluator failed to produce a verdict, so no escalation rung was spent.';
  }
  if (verdict === 'pass-with-warning') {
    return 'Remedy: kept the attempt with the warning attached for operator review.';
  }
  return undefined;
};

/**
 * Append the `### Outcome detail` subsection — the plain-prose explanation of a non-clean exit.
 * No-op when there is neither a warning nor an escalation (the clean-pass path), so a pass entry
 * stays byte-identical to the pre-widening output.
 */
const appendOutcomeDetail = (lines: string[], input: JournalEntryInput): void => {
  const bullets: string[] = [];
  if (input.warning !== undefined) bullets.push(warningSentence(input.warning));
  const remedy = remedySentence(input.verdict, input.escalation, input.warning);
  if (remedy !== undefined) bullets.push(remedy);
  if (bullets.length === 0) return;
  lines.push('### Outcome detail');
  for (const b of bullets) lines.push(`- ${b}`);
  lines.push('');
};

/**
 * Render one journal section. The string is intended to be appended verbatim to an existing
 * journal file via the `AppendFile` port — it carries its own leading + trailing whitespace
 * so consecutive sections never abut.
 */
export const renderJournalEntry = (input: JournalEntryInput): string => {
  const sha = input.commitSha !== undefined ? input.commitSha.slice(0, SHA_DISPLAY_LENGTH) : EM_DASH;
  const outcome =
    input.outcome.trim().length > 0 ? neutralizeProseHeadings(input.outcome.trim()) : '_(no outcome paragraph)_';
  const lines: string[] = [];
  lines.push('');
  lines.push(renderSectionHeader(input.taskName, input.attemptN, input.taskId));
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
  appendOutcomeDetail(lines, input);
  appendSubsection(lines, 'Changes', input.changes);
  appendSubsection(lines, 'Decisions', input.decisions);
  appendLearningsSubsection(lines, input.learnings);
  appendSubsection(lines, 'Notes', input.notes);
  return lines.join('\n');
};

/**
 * Render the sprint header — the single block written once at sprint creation. Header carries
 * invariant metadata only (no ticket list); the canonical ticket source is `sprint.json`.
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
 */
export const renderJournalSeparator = (input: {
  readonly status: 'activated' | 'review' | 'closed';
  readonly at: IsoTimestamp;
}): string => {
  const label =
    input.status === 'activated' ? 'activated' : input.status === 'review' ? 'transitioned to review' : 'closed';
  return `\n---\n\n_Sprint ${label} at ${String(input.at)}_\n\n`;
};
