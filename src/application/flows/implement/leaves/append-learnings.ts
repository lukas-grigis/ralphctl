import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { deriveTaskKind } from '@src/business/task/derive-task-kind.ts';
import { deriveLearningId, type LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { resolveWritableLearningsLedgerPath } from '@src/application/flows/_shared/memory/ledger-path.ts';
import { appendLearningsAndMirror } from '@src/application/flows/_shared/memory/ledger-writer.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import { dedupeLearnings } from '@src/application/flows/implement/leaves/_shared/dedupe-learnings.ts';
import type { LearningEntry } from '@src/domain/signal.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * WRITE side of the procedural-memory learnings pipeline. Persists the `<learning>` signals the
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
 * Running once per attempt (inside the attempt loop) is intentional: a learning emitted on
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
  /** Atomic writer for the derived `learnings.md` mirror, regenerated after every append. */
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface AppendLearningsLeafOpts {
  /** `<dataRoot>/memory` — the durable, project-scoped learnings root. */
  readonly memoryRoot: AbsolutePath;
  /** The owning project's id — selects the per-project ledger subdirectory. */
  readonly projectId: string;
  /** The owning project's slug — builds the human-readable `<id>--<slug>/` ledger subdirectory. */
  readonly projectSlug: Slug;
  /** Absolute path of the repository the task ran against (the ledger's `repo` field). */
  readonly repoPath: AbsolutePath;
  /** Human-friendly repository name (the ledger's `repoName` field). */
  readonly repoName: string;
}

interface AppendLearningsInput {
  /** Resolve the ledger path at execute time (tolerant write-side resolver — never splits the dir). */
  readonly ledgerPath: () => Promise<Result<AbsolutePath, DomainError>>;
  readonly records: readonly LearningRecord[];
}

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
  learnings: readonly LearningEntry[]
): readonly LearningRecord[] => {
  const taskKind = deriveTaskKind(task);
  const repo = String(opts.repoPath);
  const timestamp = String(deps.clock());
  return learnings.map(
    (entry): LearningRecord => ({
      v: 1,
      id: deriveLearningId(repo, taskKind, entry.text),
      text: entry.text,
      ...(entry.context !== undefined ? { context: entry.context } : {}),
      ...(entry.appliesTo !== undefined ? { appliesTo: entry.appliesTo } : {}),
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
        // Resolve the WRITE path tolerantly: append into the EXISTING memory dir (slugged or legacy
        // bare) when one is present, only creating the slugged dir when neither exists. This is what
        // stops a declined-migration user's legacy learnings from being stranded in a second dir.
        const resolved = await input.ledgerPath();
        if (!resolved.ok) {
          log.warn(`append-learnings-${String(taskId)} could not resolve ledger path`, {
            error: resolved.error.message,
          });
          return Result.ok(undefined) as Result<void, StorageError>;
        }
        // Append every record, then regenerate the human-readable learnings.md mirror from the full
        // ledger. Best-effort: an append failure is logged and the leaf still returns ok — a ledger
        // hiccup must never block the attempt (the read side dedups by id, so an orphaned earlier
        // line re-appears as the same candidate next time). The mirror regeneration never fails.
        const result = await appendLearningsAndMirror(resolved.value, input.records, {
          appendFile: deps.appendFile,
          writeFile: deps.writeFile,
          log,
        });
        if (!result.ok) {
          log.warn(`append-learnings-${String(taskId)} append failed`, {
            path: String(resolved.value),
            error: result.error.message,
          });
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
      // Read the STILL-POPULATED accumulator (progress-journal clears it AFTER us). Dedupe so an
      // identical learning emitted twice in one attempt produces one row.
      const learnings = dedupeLearnings(ctx.currentAttemptLearnings ?? []);
      const records = buildRecords(deps, opts, task, String(ctx.sprintId), learnings);
      // The path is resolved at execute time (async tolerant write-side resolver), so the still-sync
      // input projection just threads the resolver thunk through.
      return {
        ledgerPath: () => resolveWritableLearningsLedgerPath(opts.memoryRoot, opts.projectId, opts.projectSlug),
        records,
      };
    },
    // Deliberately leaves the accumulators intact — the downstream `progress-journal` leaf reads
    // and clears `currentAttemptLearnings`. Returning ctx unchanged preserves that contract.
    output: (ctx) => ctx,
  });
