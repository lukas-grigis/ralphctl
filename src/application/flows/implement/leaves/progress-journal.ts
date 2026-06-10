import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Attempt, AttemptWarning } from '@src/domain/entity/attempt.ts';
import {
  renderJournalEntry,
  type JournalEscalation,
  type JournalVerdict,
  type JournalWarning,
} from '@src/business/sprint/render-journal-entry.ts';
import { dedupeLearnings } from '@src/application/flows/implement/leaves/_shared/dedupe-learnings.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Append one task-attempt section to `<sprintDir>/progress.md` (audit-[07]).
 *
 * Runs immediately after `settle-attempt-<taskId>` so the just-settled attempt's facts
 * (commit sha, verdict, attempt count, duration) are available on ctx without re-deriving
 * from chain.log. Reads no log files — the journal is the sole writer; the canonical state
 * lives in `tasks.json` / `execution.json` already.
 *
 * Best-effort by contract: a write failure is logged and the chain proceeds. The journal is
 * a derived artefact; blocking sprint progress to refresh it would be worse than letting
 * the next attempt's append heal the file.
 */
export interface ProgressJournalLeafDeps {
  readonly appendFile: AppendFile;
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

const attemptDurationMs = (attempt: Attempt | undefined): number | undefined => {
  if (attempt === undefined || attempt.status === 'running') return undefined;
  return new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime();
};

/**
 * Factory — `progress-journal-<taskId>`. Reads ctx.tasks to find the just-settled task by id
 * (settle-attempt clears `currentTask` so we look up by the captured taskId), then appends.
 */
export const progressJournalLeaf = (
  deps: ProgressJournalLeafDeps,
  opts: ProgressJournalLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, JournalInput, void>(`progress-journal-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const attempt = latestAttempt(input.task);
        const verdict = deriveVerdict(input.task, attempt);
        // The warning / escalation fields are projected only when they exist, so the clean-pass
        // entry stays byte-identical to the pre-widening output (no `### Outcome detail`).
        const warning = attempt?.warning !== undefined ? toJournalWarning(attempt.warning) : undefined;
        // Surface the model-ladder transition on the failing-then-retrying (`escalated`) entry and
        // on a `pass-with-warning` whose prior climb is still stamped on the task — EXCEPT when
        // this attempt's exit was `malformed`: that retry bypasses the ladder by design, so any
        // stamp on the task is a stale prior climb, not this attempt's remedy.
        const escalation =
          (verdict === 'escalated' || verdict === 'pass-with-warning') && attempt?.warning?.kind !== 'malformed'
            ? toJournalEscalation(input.task)
            : undefined;
        const text = renderJournalEntry({
          taskName: input.task.name,
          attemptN: input.task.attempts.length,
          verdict,
          outcome: renderOutcomeParagraph(input.task, attempt),
          roundN: input.roundN,
          totalRounds: opts.totalRounds,
          ...(attemptDurationMs(attempt) !== undefined ? { durationMs: attemptDurationMs(attempt)! } : {}),
          ...(warning !== undefined ? { warning } : {}),
          ...(escalation !== undefined ? { escalation } : {}),
          changes: input.changes,
          decisions: input.decisions,
          learnings: input.learnings,
          notes: input.notes,
          ...(attempt?.commitSha !== undefined ? { commitSha: String(attempt.commitSha) } : {}),
          timestamp: deps.clock(),
        });
        const result = await deps.appendFile(input.progressFile, text);
        if (!result.ok) {
          deps.logger.named('implement.progress-journal').warn(`progress-journal-${String(taskId)} append failed`, {
            path: String(input.progressFile),
            error: result.error.message,
          });
        }
        // Best-effort: never halt the chain on a journal-write hiccup.
        return Result.ok(undefined) as Result<void, StorageError | InvalidStateError>;
      },
    },
    input: (ctx) => {
      const task = (ctx.tasks ?? []).find((t) => t.id === taskId);
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
