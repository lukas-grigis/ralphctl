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
import type { Attempt } from '@src/domain/entity/attempt.ts';
import { renderJournalEntry } from '@src/business/sprint/render-journal-entry.ts';
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
  readonly decisionsCount: number;
}

const collectDecisionSignals = (decisions: readonly string[] | undefined): number => {
  if (decisions === undefined || decisions.length === 0) return 0;
  const seen = new Set<string>();
  for (const d of decisions) {
    seen.add(d.trim());
  }
  return seen.size;
};

const renderOutcomeParagraph = (task: Task, attempt: Attempt | undefined): string => {
  if (task.status === 'blocked') {
    return task.blockedReason.trim().length > 0
      ? `Blocked: ${task.blockedReason.trim()}`
      : 'Blocked — no reason recorded.';
  }
  if (task.status === 'done') {
    const critique = attempt?.critique?.trim();
    if (critique !== undefined && critique.length > 0) {
      return critique;
    }
    return 'Task completed successfully.';
  }
  // in_progress / todo shouldn't happen at the journal-append point (settle ran first), but
  // produce a safe fallback so the section still renders rather than throwing.
  return `Settled with task status \`${task.status}\`.`;
};

const latestAttempt = (task: Task): Attempt | undefined => task.attempts[task.attempts.length - 1];

const attemptDurationMs = (attempt: Attempt | undefined): number | undefined => {
  if (attempt === undefined || attempt.status === 'running') return undefined;
  return new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime();
};

/**
 * Factory — `progress-journal-<taskId>`. Reads ctx.tasks to find the just-settled task by id
 * (settle-attempt clears `currentTask` so we look up by the captured taskId), then appends.
 *
 * @public
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
        const verdict: 'pass' | 'blocked' = input.task.status === 'blocked' ? 'blocked' : 'pass';
        const text = renderJournalEntry({
          taskName: input.task.name,
          attemptN: input.task.attempts.length,
          verdict,
          outcome: renderOutcomeParagraph(input.task, attempt),
          roundN: input.roundN,
          totalRounds: opts.totalRounds,
          ...(attemptDurationMs(attempt) !== undefined ? { durationMs: attemptDurationMs(attempt)! } : {}),
          decisionsCount: input.decisionsCount,
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
      const decisionsCount = collectDecisionSignals(ctx.currentAttemptDecisions);
      return {
        progressFile: opts.progressFile,
        task,
        roundN,
        decisionsCount,
      };
    },
    // settle-attempt cleared `currentAttemptDecisions` already? No — settle clears its own
    // per-attempt fields but leaves the decisions accumulator for us to read. We clear it here
    // so the next task starts with an empty accumulator.
    output: (ctx) => ({ ...ctx, currentAttemptDecisions: undefined }),
  });
