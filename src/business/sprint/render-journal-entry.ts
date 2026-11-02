import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type {
  AbortCause,
  Attempt,
  AttemptWarning,
  Attribution,
  PlateauSource,
  VerifyRunOutcome,
  VerifyRunPhase,
} from '@src/domain/entity/attempt.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import { formatDuration } from '@src/business/_shared/format-duration.ts';
import { neutralizeProseHeadings, sanitizeInline } from '@src/business/sprint/journal-sanitize.ts';
import { renderSectionHeader } from '@src/business/sprint/journal-structure.ts';
import { renderSprintIdentity } from '@src/business/sprint/render-sprint-state-header.ts';

/**
 * The journal is read by humans AND inlined into the next generator's `<prior_progress>`, so
 * `pass-with-warning` (settled done with a warning) and `escalated` (failed, retried by the
 * escalation policy) must never masquerade as `pass`.
 */
export type JournalVerdict = 'pass' | 'pass-with-warning' | 'escalated' | 'blocked';

/** Flattened `AttemptWarning`; the kind-specific fields are present only for their kind. */
export interface JournalWarning {
  readonly kind: AttemptWarning['kind'];
  /** One-line detail: parse error, verify stderr head, crash text, … */
  readonly detail?: string;
  readonly dimensions?: readonly string[];
  /** Picks the plateau sentence; absent (legacy) falls back to the `threshold` wording. */
  readonly source?: PlateauSource;
  readonly turnsUsed?: number;
  readonly turnBudget?: number;
}

/** `from === to` is a top-of-ladder same-model nudge, rendered as such so the next generator isn't misled. */
export interface JournalEscalation {
  readonly from: string;
  readonly to: string;
}

export interface JournalVerifyRun {
  readonly phase: VerifyRunPhase;
  /** Empty on a `skipped` outcome. */
  readonly command: string;
  readonly outcome: VerifyRunOutcome;
  readonly flakyFailure?: { readonly command: string; readonly exitCode: number };
}

/**
 * What the harness itself observed and did this attempt, composed from `Attempt` fields only —
 * never AI narrative — so a successor needn't re-derive it from raw logs. Every field is optional;
 * the subsection is dropped when none resolve.
 */
export interface JournalContinuationState {
  /** The attempt's own status; an `escalated` verdict can be `failed` or `malformed` here. */
  readonly attemptStatus?: Exclude<Attempt['status'], 'running'>;
  readonly verifyRuns?: readonly JournalVerifyRun[];
  readonly attribution?: Attribution;
  /** The one AI-sourced field; the leaf gates it on a commit having actually landed. */
  readonly commitSubject?: string;
  /** Present when this attempt resumed one the harness settled `aborted`. */
  readonly resumedAfter?: {
    readonly cause: AbortCause;
    readonly fromAttemptN: number;
    readonly abortedAt: string;
  };
  /** Present only on a best-of-N attempt — the one record that N sessions were spent, not one. */
  readonly bestOfN?: {
    /** Total candidate-loop iterations, successful or not. */
    readonly candidatesSampled: number;
    /** Candidates left after the execution filter and dedupe, before judging. */
    readonly survivors: number;
    /** 1-based index of the applied candidate; absent when nothing survived. */
    readonly winnerIndex?: number;
  };
}

/**
 * One task-attempt section for the append-only `<sprintDir>/progress.md`: header, timestamp,
 * outcome paragraph, the Verdict / Round / Duration / Commit block, then `### Continuation state`,
 * `### Outcome detail`, `### Changes`, `### Decisions`, `### Learnings`, `### Notes` — each dropped
 * when empty. Lists arrive deduped; the renderer only formats.
 */
export interface JournalEntryInput {
  readonly taskName: string;
  /** Embedded in the header so identical names can't collide and a rename can't orphan sections. */
  readonly taskId: string;
  readonly attemptN: number;
  readonly verdict: JournalVerdict;
  readonly outcome: string;
  readonly roundN: number;
  readonly totalRounds: number;
  /** `undefined` renders as `—`. */
  readonly durationMs?: number;
  readonly warning?: JournalWarning;
  readonly escalation?: JournalEscalation;
  readonly changes: readonly string[];
  readonly decisions: readonly string[];
  readonly learnings: readonly LearningEntry[];
  readonly notes: readonly string[];
  /** Missing when the attempt blocked. */
  readonly commitSha?: string;
  /** Corrective `signals.json` nudges — budget-free, so this is their only operator-facing trace. */
  readonly correctiveNudges?: { readonly generator: number; readonly evaluator: number };
  readonly continuation?: JournalContinuationState;
  readonly timestamp: IsoTimestamp;
}

const EM_DASH = '—';

const SHA_DISPLAY_LENGTH = 7;

/**
 * Interior lines of multi-line entries indent as list continuations, which doubles as the
 * heading-forgery neutralization (see {@link neutralizeProseHeadings}).
 */
const appendSubsection = (lines: string[], heading: string, entries: readonly string[]): void => {
  if (entries.length === 0) return;
  lines.push(`### ${heading}`);
  for (const entry of entries) {
    lines.push(`- ${entry.split('\n').join('\n  ')}`);
  }
  lines.push('');
};

/** Bold insight bullet with optional `Context:` / `Applies to:` sub-bullets. */
const appendLearningsSubsection = (lines: string[], entries: readonly LearningEntry[]): void => {
  if (entries.length === 0) return;
  lines.push('### Learnings');
  for (const entry of entries) {
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
 * Branched on `source`: only `threshold` compares two evaluations' failure sets, so its "identical
 * failure" wording would misattribute the retired detectors that old records still carry.
 */
const plateauSentence = (warning: JournalWarning): string => {
  const dims =
    warning.dimensions !== undefined && warning.dimensions.length > 0
      ? ` on the same failed dimension${warning.dimensions.length === 1 ? '' : 's'}: ${warning.dimensions.join(', ')}`
      : '';
  const detector = warning.source !== undefined ? ` (detector: ${warning.source})` : '';
  if (warning.source === 'diversity') {
    return `The evaluator plateaued — the generator repeated the same failed-dimension pattern across the whole plateau window without changing approach${dims}${detector}.`;
  }
  if (warning.source === 'entropy') {
    // The entropy detector always carried `dimensions: []`, so `dims` is not interpolated.
    return `The evaluator plateaued — the generator's reported actions collapsed onto a narrow set of signal kinds across the plateau window (low action-kind diversity)${detector}.`;
  }
  return `The evaluator plateaued — two consecutive evaluations flagged the identical failure${dims}${detector}.`;
};

/** Plain prose, not glyphs: the journal is the generator's cross-attempt memory. */
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

/** A malformed exit retries on the same model without a ladder rung, so it gets its own sentence. */
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
  runs.toSorted((a, b) => (a.phase === b.phase ? 0 : a.phase === 'pre' ? -1 : 1));

/** One verify bullet; a flaky pass names its gate so a reclassified red never goes silent. */
const renderVerifyLine = (run: JournalVerifyRun): string => {
  const command = sanitizeInline(run.command);
  const base = `- Verify (${run.phase}): ${command.length > 0 ? command : EM_DASH} — ${run.outcome}`;
  if (run.flakyFailure === undefined) return base;
  const flaky = sanitizeInline(run.flakyFailure.command);
  return `${base} — flaky: \`${flaky}\` failed (exit ${String(run.flakyFailure.exitCode)}), passed on harness re-run`;
};

const renderResumedAfter = (resumedAfter: NonNullable<JournalContinuationState['resumedAfter']>): string =>
  `- Resumed after: ${resumedAfter.cause} (attempt ${String(resumedAfter.fromAttemptN)} aborted at ${resumedAfter.abortedAt})`;

const renderBestOfN = (bestOfN: NonNullable<JournalContinuationState['bestOfN']>): string => {
  const winner =
    bestOfN.winnerIndex !== undefined ? `candidate ${String(bestOfN.winnerIndex)} applied` : 'none applied';
  return `- Best-of-N: ${String(bestOfN.candidatesSampled)} sampled, ${String(bestOfN.survivors)} survived selection, ${winner}`;
};

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

/** Carries its own leading and trailing blank lines so appended sections never abut. */
export const renderJournalEntry = (input: JournalEntryInput): string => {
  const sha = input.commitSha !== undefined ? input.commitSha.slice(0, SHA_DISPLAY_LENGTH) : EM_DASH;
  const outcome =
    input.outcome.trim().length > 0 ? neutralizeProseHeadings(input.outcome.trim()) : '_(no outcome paragraph)_';
  const lines = [
    '',
    renderSectionHeader(input.taskName, input.attemptN, input.taskId),
    '',
    `_${String(input.timestamp)}_`,
    '',
    outcome,
    '',
    `- Verdict: ${input.verdict}`,
    `- Round: round ${String(input.roundN)} of ${String(input.totalRounds)}`,
    `- Duration: ${formatDuration(input.durationMs)}`,
    `- Commit: ${sha}`,
    '',
  ];
  appendContinuationState(lines, input.continuation);
  appendOutcomeDetail(lines, input);
  appendSubsection(lines, 'Changes', input.changes);
  appendSubsection(lines, 'Decisions', input.decisions);
  appendLearningsSubsection(lines, input.learnings);
  appendSubsection(lines, 'Notes', input.notes);
  return lines.join('\n');
};

/** Creation-time journal header — the same identity block the derived state header re-emits. */
export const renderJournalSprintHeader = (input: {
  readonly sprintName: string;
  readonly sprintId: string;
  readonly createdAt: IsoTimestamp;
}): string => renderSprintIdentity(input).join('\n');

/** Separator appended between task sections on a sprint status transition. */
export const renderJournalSeparator = (input: {
  readonly status: 'activated' | 'review' | 'closed';
  readonly at: IsoTimestamp;
}): string => {
  const label =
    input.status === 'activated' ? 'activated' : input.status === 'review' ? 'transitioned to review' : 'closed';
  return `\n---\n\n_Sprint ${label} at ${String(input.at)}_\n\n`;
};
