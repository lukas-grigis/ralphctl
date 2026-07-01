import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt, AttemptWarning } from '@src/domain/entity/attempt.ts';
import {
  renderJournalEntry,
  type JournalEscalation,
  type JournalVerdict,
  type JournalWarning,
} from '@src/business/sprint/render-journal-entry.ts';
import { renderSectionHeader } from '@src/business/sprint/journal-structure.ts';
import { renderSprintStateHeader, type SprintStateTask } from '@src/business/sprint/render-sprint-state-header.ts';
import { parseJournalCreatedAt, regenerateJournal } from '@src/business/sprint/regenerate-journal-header.ts';
import { dedupeLearnings } from '@src/application/flows/implement/leaves/_shared/dedupe-learnings.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Write the just-settled task-attempt section into `<sprintDir>/progress.md` (audit-[07]) and
 * regenerate the DERIVED sprint-state header band in place.
 *
 * Runs immediately after `settle-attempt-<taskId>` so the attempt's facts (commit sha, verdict,
 * attempt count, duration) are available on ctx without re-deriving from chain.log. Reads no log
 * files — the canonical state lives in `tasks.json` / `execution.json` already.
 *
 * Write path (NOT a blind append): read the file, split the always-kept header band from the
 * append-only attempt sections, regenerate the header band from canonical data (sprint + tasks +
 * execution), append the new attempt section, and write the whole file atomically. The header band
 * stays an accurate machine-derived snapshot; the attempt sections are never rewritten.
 *
 * FAIL-LOUD / self-healing for the section write: the per-attempt section is the NEXT attempt's
 * memory, so a dropped write silently removes a warning/escalation the next session must honour. A
 * failed write is retried once; if it still fails, a VISIBLE in-file gap marker is written instead so
 * the loss is detectable, and the failure is logged at ERROR level. The chain still proceeds — the
 * loudness is the marker + error log, not a halt.
 */
export interface ProgressJournalLeafDeps {
  /** Atomic whole-file writer — the regenerated journal is written via temp+rename. */
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface ProgressJournalLeafOpts {
  readonly progressFile: AbsolutePath;
  readonly totalRounds: number;
}

interface JournalInput {
  readonly progressFile: AbsolutePath;
  readonly task: Task;
  readonly roundN: number;
  readonly changes: readonly string[];
  readonly decisions: readonly string[];
  readonly learnings: readonly LearningEntry[];
  readonly notes: readonly string[];
  /** Canonical sprint identity + lifecycle, for the derived state header. Undefined → identity is preserved from the file. */
  readonly sprint?: Sprint | undefined;
  /** Branch / PR url for the derived state header. */
  readonly execution?: SprintExecution | undefined;
  /** Every task in the sprint — drives the per-task table, blockers, and stale lists. */
  readonly allTasks: readonly Task[];
}

/**
 * Trim + dedupe a per-attempt signal-text accumulator. Returns the deduped list in first-seen
 * order. Empty / undefined input → empty array; the renderer drops empty subsections.
 */
const dedupeTexts = (texts: readonly string[] | undefined): readonly string[] => {
  if (texts === undefined || texts.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const renderOutcomeParagraph = (task: Task, attempt: Attempt | undefined): string => {
  if (task.status === 'blocked') {
    return task.blockedReason.trim().length > 0
      ? `Blocked: ${task.blockedReason.trim()}`
      : 'Blocked — no reason recorded.';
  }
  if (task.status === 'done') {
    // A PASSED final evaluation outranks a stale critique: the critique on the attempt may be
    // left over from an earlier failing round of the same attempt (the warn-then-pass shape),
    // and printing it as the outcome would feed a false failure narrative to the next prompts.
    if (attempt?.evaluation?.status === 'passed') {
      return attempt.warning !== undefined
        ? 'Task settled as done with a warning attached.'
        : 'Task completed successfully.';
    }
    const critique = attempt?.critique?.trim();
    if (critique !== undefined && critique.length > 0) {
      return critique;
    }
    // Never claim a clean success when the final attempt carries a warning — the journal feeds
    // the next attempt's generator, so a budget / plateau / malformed / verify-failed exit must
    // read as "done, but flagged" and let the `### Outcome detail` subsection state why.
    return attempt?.warning !== undefined
      ? 'Task settled as done with a warning attached.'
      : 'Task completed successfully.';
  }
  // in_progress: the attempt failed and the escalation / malformed-retry policy reopened the
  // task for another attempt (the journal leaf runs inside the per-attempt loop, so it appends
  // before the next attempt starts). Surface the critique that drives the retry when present.
  if (task.status === 'in_progress') {
    const critique = attempt?.critique?.trim();
    return critique !== undefined && critique.length > 0
      ? `Attempt did not pass; the harness is retrying. ${critique}`
      : 'Attempt did not pass; the harness is retrying.';
  }
  // todo shouldn't reach the journal-append point (settle ran first); safe fallback.
  return `Settled with task status \`${task.status}\`.`;
};

/**
 * Derive the journal verdict from the just-settled task. The journal leaf runs inside the
 * per-attempt loop right after settle, so the task status is authoritative:
 *
 *  - `blocked`     → the task failed on its own merits / upstream cascade.
 *  - `in_progress` → the attempt failed and the escalation (model climb) or malformed-retry
 *                    policy reopened the task for another attempt → `escalated`.
 *  - `done` + the final attempt carries a warning → `pass-with-warning`.
 *  - `done`, no warning → `pass`.
 */
const deriveVerdict = (task: Task, attempt: Attempt | undefined): JournalVerdict => {
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'in_progress') return 'escalated';
  if (task.status === 'done' && attempt?.warning !== undefined) return 'pass-with-warning';
  return 'pass';
};

/** Flatten a domain {@link AttemptWarning} into the renderer's serialization-free shape. */
const toJournalWarning = (warning: AttemptWarning): JournalWarning => {
  switch (warning.kind) {
    case 'budget-exhausted':
      return { kind: 'budget-exhausted', turnsUsed: warning.turnsUsed, turnBudget: warning.turnBudget };
    case 'plateau':
      return { kind: 'plateau', dimensions: warning.dimensions };
    case 'malformed':
      return { kind: 'malformed', detail: warning.detail };
    case 'verify-failed': {
      const exit = warning.exitCode !== null ? `exit ${String(warning.exitCode)}` : 'no exit code';
      const detail = warning.stderr.trim().length > 0 ? `${exit} — ${warning.stderr.trim()}` : exit;
      return { kind: 'verify-failed', detail };
    }
    case 'crashed':
      return { kind: 'crashed', detail: warning.detail };
  }
};

/**
 * Project the task-level escalation stamp into the renderer shape. `escalatedFromModel` /
 * `escalatedToModel` are re-stamped per climb and PERSIST across later attempts — so the stamp
 * only reflects "the transition the policy just applied" when this attempt's exit actually went
 * through the escalation policy. The malformed same-model retry deliberately bypasses the ladder
 * (the evaluator's failure, not the generator's — finalize stamps nothing), so on that path a
 * PRIOR attempt's climb would render as this attempt's remedy: a false
 * 'escalated the generator model from A to B' line in the next generator's cross-attempt memory.
 * The caller suppresses the projection when the latest warning kind is 'malformed'.
 */
const toJournalEscalation = (task: Task): JournalEscalation | undefined =>
  task.escalatedFromModel !== undefined && task.escalatedToModel !== undefined
    ? { from: task.escalatedFromModel, to: task.escalatedToModel }
    : undefined;

const latestAttempt = (task: Task): Attempt | undefined => task.attempts[task.attempts.length - 1];

/**
 * True when the attempt's warning kind retries WITHOUT burning a model-ladder rung (`malformed` —
 * the evaluator's failure; `crashed` — a transient process death). On those exits the persisted
 * `escalatedFromModel`/`To` stamp reflects a PRIOR climb, so projecting it would misrepresent this
 * attempt's remedy — the caller suppresses the escalation projection when this returns true.
 */
const ladderBypassed = (warning: AttemptWarning | undefined): boolean =>
  warning?.kind === 'malformed' || warning?.kind === 'crashed';

const attemptDurationMs = (attempt: Attempt | undefined): number | undefined => {
  if (attempt === undefined || attempt.status === 'running') return undefined;
  return new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime();
};

/** Project one domain task into the derived-header row shape (status + k/N criteria + blocker reason). */
const projectStateTask = (task: Task): SprintStateTask => {
  const verdicts = task.criteriaVerdicts ?? {};
  return {
    name: task.name,
    status: task.status,
    // "Passes" = verification criteria the harness graded `passed` over the task's total criteria —
    // the durable k-of-N checklist folded from the evaluator's structured per-criterion verdicts.
    criteriaPassed: task.verificationCriteria.filter((c) => verdicts[c.id] === 'passed').length,
    criteriaTotal: task.verificationCriteria.length,
    attemptCount: task.attempts.length,
    ...(task.status === 'blocked' ? { blockedReason: task.blockedReason } : {}),
  };
};

/** Identity line `# Sprint: <name>` from an existing header band — fallback when ctx.sprint is absent. */
const parseSprintName = (existing: string): string | undefined => /^# Sprint: (.+)$/m.exec(existing)?.[1]?.trim();

/**
 * Render the derived state header from canonical ctx data. `created` is carried forward from the
 * existing file (stable across regenerations) and falls back to the clock for a brand-new journal;
 * identity / status degrade gracefully when `ctx.sprint` is absent so the leaf never throws on a
 * derived artefact.
 */
const buildStateHeader = (input: JournalInput, existing: string, clock: () => IsoTimestamp): string =>
  renderSprintStateHeader({
    sprintName: input.sprint?.name ?? parseSprintName(existing) ?? String(input.task.id),
    sprintId: input.sprint !== undefined ? String(input.sprint.id) : String(input.task.id),
    createdAt: (parseJournalCreatedAt(existing) ?? String(clock())) as IsoTimestamp,
    status: input.sprint?.status ?? 'active',
    branch: input.execution?.branch ?? null,
    pullRequestUrl: input.execution?.pullRequestUrl !== undefined ? String(input.execution.pullRequestUrl) : null,
    tasks: input.allTasks.map(projectStateTask),
  });

/**
 * Render this attempt's journal section. The warning / escalation fields are projected only when they
 * exist, so the clean-pass entry stays byte-identical to the pre-widening output (no `### Outcome
 * detail`). The model-ladder transition rides the `escalated` / `pass-with-warning` entry EXCEPT when
 * the exit was `malformed` or `crashed` — both retry WITHOUT burning a ladder rung, so any stamp is a
 * stale prior climb that would misrepresent this attempt's remedy.
 */
const buildAttemptSection = (input: JournalInput, totalRounds: number, clock: () => IsoTimestamp): string => {
  const attempt = latestAttempt(input.task);
  const verdict = deriveVerdict(input.task, attempt);
  const warning = attempt?.warning !== undefined ? toJournalWarning(attempt.warning) : undefined;
  const escalation =
    (verdict === 'escalated' || verdict === 'pass-with-warning') && !ladderBypassed(attempt?.warning)
      ? toJournalEscalation(input.task)
      : undefined;
  const durationMs = attemptDurationMs(attempt);
  return renderJournalEntry({
    taskName: input.task.name,
    taskId: String(input.task.id),
    attemptN: input.task.attempts.length,
    verdict,
    outcome: renderOutcomeParagraph(input.task, attempt),
    roundN: input.roundN,
    totalRounds,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(warning !== undefined ? { warning } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
    changes: input.changes,
    decisions: input.decisions,
    learnings: input.learnings,
    notes: input.notes,
    ...(attempt?.commitSha !== undefined ? { commitSha: String(attempt.commitSha) } : {}),
    timestamp: clock(),
  });
};

/** Best-effort read of the current journal file — absent / unreadable resolves to the empty string. */
const readExisting = async (path: AbsolutePath): Promise<string> => {
  try {
    return await fs.readFile(String(path), 'utf8');
  } catch {
    return '';
  }
};

/**
 * Write the regenerated journal, FAIL-LOUD for the section: retry once on failure (self-heal), then
 * fall back to a visible in-file gap marker so the dropped section is detectable, logging at ERROR
 * level. Never halts the chain — the journal is a derived artefact, but the loss is now loud.
 */
const writeJournalFailLoud = async (
  deps: ProgressJournalLeafDeps,
  taskId: TaskId,
  progressFile: AbsolutePath,
  content: string,
  markerContent: string
): Promise<void> => {
  const log = deps.logger.named('implement.progress-journal');
  const first = await deps.writeFile(progressFile, content);
  if (first.ok) return;

  const retry = await deps.writeFile(progressFile, content);
  if (retry.ok) {
    log.warn(`progress-journal-${String(taskId)} section write failed once, self-healed on retry`, {
      path: String(progressFile),
      error: first.error.message,
    });
    return;
  }

  const marker = await deps.writeFile(progressFile, markerContent);
  if (marker.ok) {
    log.error(`progress-journal-${String(taskId)} section write failed — wrote a visible gap marker instead`, {
      path: String(progressFile),
      firstError: first.error.message,
      retryError: retry.error.message,
    });
    return;
  }
  log.error(`progress-journal-${String(taskId)} section write failed and the gap marker could not be written`, {
    path: String(progressFile),
    retryError: retry.error.message,
    markerError: marker.error.message,
  });
};

/**
 * Factory — `progress-journal-<taskId>`. Reads ctx.tasks to find the just-settled task by id
 * (settle-attempt clears `currentTask` so we look up by the captured taskId), regenerates the
 * derived header from canonical ctx state, appends the attempt section, and writes atomically.
 */
export const progressJournalLeaf = (
  deps: ProgressJournalLeafDeps,
  opts: ProgressJournalLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, JournalInput, void>(`progress-journal-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const newSection = buildAttemptSection(input, opts.totalRounds, deps.clock);

        // Regenerate the always-kept header band from canonical state, then append this attempt
        // section. The existing file's append-only sections ride through verbatim.
        const existing = await readExisting(input.progressFile);
        const stateHeader = buildStateHeader(input, existing, deps.clock);
        const content = regenerateJournal({ existing, stateHeader, newSection });

        // Fallback payload if the section write keeps failing: a forgery-safe section header (so the
        // delimiter + id token still parse for the next attempt) with a visible gap marker body.
        const markerSection = `\n${renderSectionHeader(input.task.name, input.task.attempts.length, String(input.task.id))}\n\n_section for the latest attempt is missing — see signals.json / git log_\n`;
        const markerContent = regenerateJournal({ existing, stateHeader, newSection: markerSection });

        await writeJournalFailLoud(deps, taskId, input.progressFile, content, markerContent);
        // The journal is a derived artefact — never halt the chain; fail-loud surfaced any loss.
        return Result.ok(undefined) as Result<void, StorageError | InvalidStateError>;
      },
    },
    input: (ctx) => {
      const allTasks = ctx.tasks ?? [];
      const task = allTasks.find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-progress-journal',
          attemptedAction: `progress-journal-${String(taskId)}`,
          message: `progress-journal-${String(taskId)}: task missing from ctx.tasks — settle-attempt must run first`,
        });
      }
      const roundN = ctx.currentRoundNum ?? task.attempts.length;
      return {
        progressFile: opts.progressFile,
        task,
        roundN,
        changes: dedupeTexts(ctx.currentAttemptChanges),
        decisions: dedupeTexts(ctx.currentAttemptDecisions),
        learnings: dedupeLearnings(ctx.currentAttemptLearnings ?? []),
        notes: dedupeTexts(ctx.currentAttemptNotes),
        sprint: ctx.sprint,
        execution: ctx.execution,
        allTasks,
      };
    },
    // settle-attempt clears its own per-attempt fields but leaves the signal accumulators for
    // us to read. We clear all four here so the next ATTEMPT (and the next task) starts with
    // empty accumulators. This is the per-attempt reset boundary: the journal leaf is the LAST
    // element of the attempt-body sequential and runs UNCONDITIONALLY on every loop iteration —
    // including a red-post-verify retry (T6) where the task settled `in_progress`. So a retried
    // attempt never inherits the REJECTED attempt's change/learning/note hints; the next
    // generator turn (and the evaluator hints derived from these accumulators) sees only its own
    // attempt's signals, not the prior failed attempt's leftovers.
    output: (ctx) => ({
      ...ctx,
      currentAttemptDecisions: undefined,
      currentAttemptChanges: undefined,
      currentAttemptLearnings: undefined,
      currentAttemptNotes: undefined,
    }),
  });
