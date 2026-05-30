import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { deriveTaskKind } from '@src/business/task/derive-task-kind.ts';
import {
  deriveLearningId,
  type LearningRecord,
  serializeLearningRecord,
} from '@src/application/flows/_shared/memory/learning-record.ts';
import { learningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * WRITE side of the Theme 6 learnings pipeline (audit-[B5]). Persists the `<learning>` signals the
 * just-settled attempt produced to the project's append-only NDJSON ledger at
 * `<memoryRoot>/<projectId>/learnings.ndjson`, one line per learning.
 *
 * ## Ordering — MUST run before `progress-journal-<taskId>`
 *
 * The journal leaf reads then CLEARS `ctx.currentAttemptLearnings` (along with the other three
 * accumulators) so the next attempt starts empty. This leaf reads the SAME still-populated
 * accumulator, so it is inserted immediately BEFORE the journal in the attempt-loop body. It does
 * NOT clear the accumulator itself — the journal still owns that, so the journal's `### Learnings`
 * subsection keeps rendering exactly the same set.
 *
 * Running once per attempt (inside the B3 attempt loop) is intentional: a learning emitted on
 * attempt 1 and re-emitted verbatim on attempt 2 lands twice on disk, but both rows carry the
 * SAME `deriveLearningId` id, so the READ side (`loadLearningsLeaf`) dedups them back to one
 * candidate. Append-only keeps the write path crash-safe; dedup is a read-side concern.
 *
 * ## Append-only — NO read-modify-write
 *
 * Each learning is `JSON.stringify(record) + '\n'` appended via the {@link AppendFile} port. The
 * leaf never reads the existing ledger to dedup — duplicate ids are collapsed on the read side.
 * This keeps the write a pure append with no race window against a concurrent reader.
 *
 * ## Best-effort
 *
 * A write/append failure is logged at warn and the leaf returns `Result.ok(undefined)` — a ledger
 * hiccup must never block the attempt. The ledger is a derived, regenerating artefact; the next
 * attempt's append heals it. A genuine cancellation (aborted `AbortSignal`) is NOT swallowed: the
 * `leaf` wrapper observes the aborted signal post-execute and converts to `AbortError`, which
 * chains forward transparently per the harness AbortError contract.
 */
export interface AppendLearningsLeafDeps {
  readonly appendFile: AppendFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface AppendLearningsLeafOpts {
  /** `<dataRoot>/memory` — the durable, project-scoped learnings root. */
  readonly memoryRoot: AbsolutePath;
  /** The owning project's id — selects the per-project ledger subdirectory. */
  readonly projectId: string;
  /** Absolute path of the repository the task ran against (the ledger's `repo` field). */
  readonly repoPath: AbsolutePath;
  /** Human-friendly repository name (the ledger's `repoName` field). */
  readonly repoName: string;
}

interface AppendLearningsInput {
  readonly ledgerPath: AbsolutePath;
  readonly records: readonly LearningRecord[];
}

/**
 * Trim + dedupe a per-attempt signal-text accumulator. Mirrors the journal leaf's `dedupeTexts`
 * (intentionally duplicated rather than shared — the two leaves keep independent control over
 * what they persist). Returns the deduped list in first-seen order; empty / undefined → `[]`.
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

/**
 * Build one {@link LearningRecord} per deduped learning text. The record `id` is the stable
 * `deriveLearningId(repo, taskKind, text)` so the read side dedups a re-emitted learning onto one
 * row; `promotedAt` is always `null` on write (the distill flow stamps it later).
 */
const buildRecords = (
  deps: AppendLearningsLeafDeps,
  opts: AppendLearningsLeafOpts,
  task: Task,
  sprintId: string,
  learnings: readonly string[]
): readonly LearningRecord[] => {
  const taskKind = deriveTaskKind(task);
  const repo = String(opts.repoPath);
  const timestamp = String(deps.clock());
  return learnings.map(
    (text): LearningRecord => ({
      v: 1,
      id: deriveLearningId(repo, taskKind, text),
      text,
      repo,
      repoName: opts.repoName,
      taskKind,
      sprintId,
      taskId: String(task.id),
      timestamp,
      promotedAt: null,
    })
  );
};

/**
 * Factory — `append-learnings-<taskId>`. Looks up the just-settled task by id (settle-attempt
 * clears `currentTask`), builds one {@link LearningRecord} per deduped learning, and appends them
 * to the project ledger. Inserted BEFORE `progress-journal-<taskId>` so the still-populated
 * `currentAttemptLearnings` accumulator is read before the journal clears it.
 */
export const appendLearningsLeaf = (
  deps: AppendLearningsLeafDeps,
  opts: AppendLearningsLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, AppendLearningsInput, void>(`append-learnings-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        // No learnings this attempt → nothing to append. Skip the I/O entirely.
        if (input.records.length === 0) return Result.ok(undefined) as Result<void, StorageError>;

        const log = deps.logger.named('implement.append-learnings');
        for (const record of input.records) {
          const result = await deps.appendFile(input.ledgerPath, serializeLearningRecord(record));
          if (!result.ok) {
            // Best-effort: log and keep going. A partial append (some lines written, one failed)
            // is harmless — the read side dedups by id, so an orphaned earlier line just re-appears
            // as the same candidate next time.
            log.warn(`append-learnings-${String(taskId)} append failed`, {
              path: String(input.ledgerPath),
              error: result.error.message,
            });
          }
        }
        return Result.ok(undefined) as Result<void, StorageError>;
      },
    },
    input: (ctx) => {
      const task = (ctx.tasks ?? []).find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-append-learnings',
          attemptedAction: `append-learnings-${String(taskId)}`,
          message: `append-learnings-${String(taskId)}: task missing from ctx.tasks — settle-attempt must run first`,
        });
      }
      const ledgerResult = learningsLedgerPath(opts.memoryRoot, opts.projectId);
      if (!ledgerResult.ok) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-append-learnings',
          attemptedAction: `append-learnings-${String(taskId)}`,
          message: `append-learnings-${String(taskId)}: could not resolve ledger path — ${ledgerResult.error.message}`,
        });
      }
      // Read the STILL-POPULATED accumulator (progress-journal clears it AFTER us). Dedupe so an
      // identical learning emitted twice in one attempt produces one row.
      const learnings = dedupeTexts(ctx.currentAttemptLearnings);
      const records = buildRecords(deps, opts, task, String(ctx.sprintId), learnings);
      return { ledgerPath: ledgerResult.value, records };
    },
    // Deliberately leaves the accumulators intact — the downstream `progress-journal` leaf reads
    // and clears `currentAttemptLearnings`. Returning ctx unchanged preserves that contract.
    output: (ctx) => ctx,
  });
