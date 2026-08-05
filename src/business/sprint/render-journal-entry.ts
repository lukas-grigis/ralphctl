import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import { formatDuration } from '@src/business/_shared/format-duration.ts';
import { neutralizeProseHeadings, sanitizeInline } from '@src/business/sprint/journal-sanitize.ts';
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
 *  - `source`      — WHICH of the three plateau detectors fired (`threshold` / `diversity` /
 *                    `entropy` — mirrors the domain `PlateauSource`, redeclared here rather than
 *                    imported so the renderer stays decoupled from the entity), present only for
 *                    the `plateau` kind and only when the leaf could resolve it. Selects which of
 *                    the three plateau sentences renders (see `warningSentence`'s `plateau`
 *                    branch) — each detector observes something different, so only `threshold`
 *                    legitimately reads as "two consecutive evaluations flagged the identical
 *                    failure". Absent `source` (legacy records written before this field existed)
 *                    falls back to the `threshold` wording.
 *  - `turnsUsed` / `turnBudget` — present only for the `budget-exhausted` kind.
 */
export interface JournalWarning {
  readonly kind: 'budget-exhausted' | 'plateau' | 'malformed' | 'verify-failed' | 'crashed';
  readonly detail?: string;
  readonly dimensions?: readonly string[];
  readonly source?: 'threshold' | 'diversity' | 'entropy';
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

/** One harness-side verify-script run, flattened from the domain `VerifyRun` for the renderer. */
export interface JournalVerifyRun {
  readonly phase: 'pre' | 'post';
  /** Verbatim shell command the harness invoked. Empty string on a `skipped` outcome. */
  readonly command: string;
  readonly outcome: 'success' | 'failed' | 'spawn-error' | 'skipped';
}

/**
 * Deterministic continuation-state facts for the successor session (arXiv 2606.02875: bounded,
 * harness-derived continuation contracts over free-form model handoff prose) — composed by the
 * leaf from `Attempt` / `RecoveryContext` fields ONLY, never AI-authored narrative. Distinct from
 * `warning` / `escalation` above (which project the AI-visible story of *why* the attempt didn't
 * cleanly pass): this is the machine record of *what the harness itself observed and did*, so a
 * successor session (or an operator) doesn't have to re-derive it from raw signals.json / verify
 * logs / git history.
 *
 * Every field is independently optional; the whole `### Continuation state` subsection is dropped
 * when none resolve — same no-orphan-heading rule as the signal subsections below.
 */
export interface JournalContinuationState {
  /**
   * The attempt's own terminal status — distinct from `verdict` above, which is the TASK-level
   * outcome `settle-attempt` derived from it. A `verdict: 'escalated'` entry can carry either
   * `failed` or `malformed` here, a distinction the verdict alone collapses.
   */
  readonly attemptStatus?: 'verified' | 'failed' | 'malformed' | 'aborted';
  /** Harness-side verify-script runs captured before (`pre`) and/or after (`post`) the generator turn. */
  readonly verifyRuns?: readonly JournalVerifyRun[];
  /**
   * Pre/post verify attribution computed by `post-task-verify` from the two runs above — WHO
   * caused the outcome, independent of the AI's own `task-verified` self-report.
   */
  readonly attribution?: 'clean' | 'regressed' | 'baseline-broken' | 'fixed-baseline';
  /**
   * Subject line of the commit that landed this attempt. The one field here sourced from an
   * AI-proposed string (the generator's `<commit-message>` signal) rather than a closed-set
   * harness enum — the leaf gates it on `commitSha` above being set, so it renders only for a
   * subject that was actually used for a commit that landed, never a discarded proposal.
   */
  readonly commitSubject?: string;
  /** Present when this attempt opened as a resume of a prior attempt the harness settled `aborted`. */
  readonly resumedAfter?: {
    readonly cause:
      'user-cancel' | 'sigterm' | 'watchdog-killed' | 'rate-limit-exhausted' | 'process-crash' | 'unknown';
    readonly fromAttemptN: number;
    readonly abortedAt: string;
  };
  /**
   * Present only when this attempt was the escalation policy's best-of-N grant (arXiv 2604.16529)
   * — the round that sampled N candidate generator sessions and applied the winner instead of
   * running one. `verifyRuns` / `attribution` above describe the WINNING candidate's own outcome
   * (or the "no diff applied" degrade on zero survivors); this field is the only place the journal
   * records that N full sessions were spent to produce it, not one.
   */
  readonly bestOfN?: {
    /** Total candidate-loop iterations this attempt spent, successful or not. */
    readonly candidatesSampled: number;
    /** Candidates remaining after the execution-filter + dedupe stages, before judging. */
    readonly survivors: number;
    /** 1-based index of the applied candidate — absent when zero survivors → no diff applied. */
    readonly winnerIndex?: number;
  };
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
 *   ### Continuation state    (only when at least one deterministic field resolves)
 *   - Attempt status: <verified | failed | malformed | aborted>
 *   - Verify (pre|post): <command-or-em-dash> — <success | failed | spawn-error | skipped>
 *   - Attribution: <clean | regressed | baseline-broken | fixed-baseline>
 *   - Commit subject: <subject>
 *   - Resumed after: <abort cause> (attempt <N> aborted at <iso timestamp>)
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
  /**
   * Per-attempt corrective-nudge tally (generator + evaluator `signals.json` contract-failure
   * retries — see `validateSignalsFileWithCorrectiveRetry`). Nudges consume no turn/attempt
   * budget by design, so this is the ONLY operator-facing surface for them — pure cost-visibility
   * instrumentation, never a failure signal on its own. Present only when at least one nudge
   * fired this attempt; absent renders no additional line (zero-noise on the well-formed path).
   */
  readonly correctiveNudges?: { readonly generator: number; readonly evaluator: number };
  /**
   * Deterministic continuation-state facts for the successor session — see
   * {@link JournalContinuationState}. Absent → the `### Continuation state` subsection is
   * dropped entirely, so a caller that doesn't supply it (older call sites, most renderer unit
   * tests) renders byte-identical to the pre-widening output.
   */
  readonly continuation?: JournalContinuationState;
  readonly timestamp: IsoTimestamp;
}

const EM_DASH = '—';

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
 * The plateau warning's sentence — branched on `source` because the three detectors observe
 * genuinely different things (see `PlateauSource` in `domain/entity/attempt.ts`); reusing one
 * clause would misattribute the `threshold` detector's "identical failure" wording to detectors
 * that never compare two evaluations' failure sets. A `(detector: …)` parenthetical is appended
 * when the source is known; an absent `source` (legacy records) falls back to `threshold` wording.
 */
const plateauSentence = (warning: JournalWarning): string => {
  const dims =
    warning.dimensions !== undefined && warning.dimensions.length > 0
      ? ` on the same failed dimension${warning.dimensions.length === 1 ? '' : 's'}: ${warning.dimensions.join(', ')}`
      : '';
  const detector = warning.source !== undefined ? ` (detector: ${warning.source})` : '';
  if (warning.source === 'diversity') {
    // `loop-diversity-check` (gen-eval-loop.ts) — the generator re-emitted the same failed-
    // dimension fingerprint for the last 3 consecutive turns without changing approach;
    // dimensions carries that repeated failed set, same as `threshold`.
    return `The evaluator plateaued — the generator repeated the same failed-dimension pattern across the last 3 consecutive turns without changing approach${dims}${detector}.`;
  }
  if (warning.source === 'entropy') {
    // `entropy-check` (gen-eval-loop.ts) — Shannon entropy over the generator's reported signal-
    // kind distribution for the latest turn collapsed below threshold. This detector never
    // compares two evaluations' failure sets, so it always carries `dimensions: []` — `dims` is
    // deliberately not interpolated into this sentence.
    return `The evaluator plateaued — the generator's reported actions collapsed onto a narrow set of signal kinds this turn (low action-kind diversity)${detector}.`;
  }
  // `threshold` (business/task/plateau-detection.ts) is the only detector that compares two
  // consecutive evaluations' failed-dimension sets — also the fallback wording for legacy records
  // written before `source` existed.
  return `The evaluator plateaued — two consecutive evaluations flagged the identical failure${dims}${detector}.`;
};

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
    case 'plateau':
      return plateauSentence(warning);
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
 * One plain-prose sentence naming how many `signals.json` corrective nudges the generator /
 * evaluator needed this attempt. Independent of `warning`/`escalation` — a corrective nudge can
 * fire on an otherwise clean pass, so this bullet is gated on its own presence, not the others'.
 */
const correctiveNudgesSentence = (nudges: { readonly generator: number; readonly evaluator: number }): string => {
  const total = nudges.generator + nudges.evaluator;
  const parts: string[] = [];
  if (nudges.generator > 0) parts.push(`generator: ${String(nudges.generator)}`);
  if (nudges.evaluator > 0) parts.push(`evaluator: ${String(nudges.evaluator)}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const noun = total === 1 ? 'nudge' : 'nudges';
  return `${String(total)} corrective signals.json ${noun} issued this attempt${breakdown} — these do not count against the turn/attempt budget.`;
};

/** `pre` always precedes `post`, regardless of the accumulation order on the source array. */
const orderedVerifyRuns = (runs: readonly JournalVerifyRun[]): readonly JournalVerifyRun[] =>
  [...runs].sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'pre' ? -1 : 1));

const renderVerifyLine = (run: JournalVerifyRun): string => {
  const command = sanitizeInline(run.command);
  return `- Verify (${run.phase}): ${command.length > 0 ? command : EM_DASH} — ${run.outcome}`;
};

const renderResumedAfter = (resumedAfter: NonNullable<JournalContinuationState['resumedAfter']>): string =>
  `- Resumed after: ${resumedAfter.cause} (attempt ${String(resumedAfter.fromAttemptN)} aborted at ${resumedAfter.abortedAt})`;

const renderBestOfN = (bestOfN: NonNullable<JournalContinuationState['bestOfN']>): string => {
  const winner =
    bestOfN.winnerIndex !== undefined ? `candidate ${String(bestOfN.winnerIndex)} applied` : 'none applied';
  return `- Best-of-N: ${String(bestOfN.candidatesSampled)} sampled, ${String(bestOfN.survivors)} survived selection, ${winner}`;
};

/**
 * Append the `### Continuation state` subsection — the deterministic, harness-derived facts a
 * successor session needs to pick up the task without re-deriving them from raw signals.json /
 * verify logs / git history (see {@link JournalContinuationState}). No-op when `continuation` is
 * absent or every field on it is absent, so a render call that doesn't supply it stays
 * byte-identical to the pre-widening output — same no-orphan-heading rule as every subsection
 * above.
 */
const appendContinuationState = (lines: string[], continuation: JournalContinuationState | undefined): void => {
  if (continuation === undefined) return;
  const bullets: string[] = [];
  if (continuation.attemptStatus !== undefined) bullets.push(`- Attempt status: ${continuation.attemptStatus}`);
  for (const run of orderedVerifyRuns(continuation.verifyRuns ?? [])) bullets.push(renderVerifyLine(run));
  if (continuation.attribution !== undefined) bullets.push(`- Attribution: ${continuation.attribution}`);
  if (continuation.commitSubject !== undefined && continuation.commitSubject.trim().length > 0) {
    bullets.push(`- Commit subject: ${sanitizeInline(continuation.commitSubject)}`);
  }
  if (continuation.resumedAfter !== undefined) bullets.push(renderResumedAfter(continuation.resumedAfter));
  if (continuation.bestOfN !== undefined) bullets.push(renderBestOfN(continuation.bestOfN));
  if (bullets.length === 0) return;
  lines.push('### Continuation state');
  for (const b of bullets) lines.push(b);
  lines.push('');
};

/**
 * Append the `### Outcome detail` subsection — the plain-prose explanation of a non-clean exit,
 * plus the corrective-nudge cost-visibility line when present. No-op when there is neither a
 * warning, an escalation, nor a nudge tally (the clean-pass path), so a pass entry stays
 * byte-identical to the pre-widening output.
 */
const appendOutcomeDetail = (lines: string[], input: JournalEntryInput): void => {
  const bullets: string[] = [];
  if (input.warning !== undefined) bullets.push(warningSentence(input.warning));
  const remedy = remedySentence(input.verdict, input.escalation, input.warning);
  if (remedy !== undefined) bullets.push(remedy);
  if (input.correctiveNudges !== undefined) bullets.push(correctiveNudgesSentence(input.correctiveNudges));
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
  appendContinuationState(lines, input.continuation);
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
