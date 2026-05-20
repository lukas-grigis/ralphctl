import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { LoadChainLog } from '@src/business/sprint/load-chain-log.ts';
import { projectSprintState } from '@src/business/sprint/state-projection.ts';
import { renderProgressMarkdown } from '@src/business/sprint/render-progress-markdown.ts';

/**
 * Atomic file writer port shape — inlined here so this sprint helper does not cross-import
 * from `business/io/`. Structurally compatible with `WriteFile` from
 * `business/io/write-file.ts` so a single adapter satisfies both consumers.
 *
 * @public
 */
export type WriteProgressFile = (path: AbsolutePath, content: string) => Promise<Result<void, StorageError>>;

/**
 * Snapshot-regenerate `<sprintDir>/progress.md` from the current sprint state.
 *
 * Replaces the streaming `progress-file-sink` (deleted in P1c) — the file is now a function
 * of the persisted entities + `chain.log`, rendered from scratch at three well-defined
 * moments instead of incrementally appended on every signal:
 *
 *  1. Sprint start (the `ensure-progress-file` leaf at the head of the implement chain).
 *  2. After every `settle-attempt-leaf` completion (one attempt settled, task state changed).
 *  3. Sprint status transitions (`active → review`, `review → done`).
 *
 * Compose-and-write semantics:
 *  1. Load `chain.log` via the injected {@link LoadChainLog} port (missing file → empty list).
 *  2. Project the entities + log into a {@link SprintState} view model.
 *  3. Render the projection to markdown.
 *  4. Atomically overwrite the target file via {@link WriteFile}.
 *
 * The atomic write is the migration path for legacy `progress.md` files: any on-disk content
 * from the old streaming sink (or hand-edited notes) is overwritten by the snapshot. The first
 * snapshot regeneration after the upgrade is the migration; no separate `delete-old-file`
 * step is needed.
 *
 * Idempotent — same state in, same file out. A snapshot regeneration triggered while no
 * entity changed produces a byte-identical file.
 *
 * Errors are propagated as `Result.error` so the caller can decide whether a failure to
 * refresh `progress.md` should abort the chain. Production wiring treats this as best-effort:
 * the snapshot is a derived artefact; the canonical state lives in `tasks.json` and
 * `chain.log`.
 *
 * @public
 */
export interface WriteProgressSnapshotDeps {
  readonly loadChainLog: LoadChainLog;
  readonly writeFile: WriteProgressFile;
  readonly clock: () => IsoTimestamp;
  readonly logger?: Logger;
}

export interface WriteProgressSnapshotInput {
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
  readonly tasks: readonly Task[];
  readonly chainLogPath: AbsolutePath;
  readonly progressFile: AbsolutePath;
  /** Optional caller-supplied current branch — passed through to the projection. */
  readonly actualBranch?: string;
}

export const writeProgressSnapshot = async (
  deps: WriteProgressSnapshotDeps,
  input: WriteProgressSnapshotInput
): Promise<Result<void, StorageError>> => {
  const log = deps.logger?.named('sprint.progress-snapshot');

  const loaded = await deps.loadChainLog(input.chainLogPath);
  // Tolerant: a transient read error degrades to an empty log so the snapshot still reflects
  // the entities. A hard storage failure here would block sprint progress just to refresh a
  // derived artefact; not worth it.
  const entries = loaded.ok ? loaded.value : [];
  if (!loaded.ok) {
    log?.warn('chain.log read failed; rendering snapshot without run history', {
      path: String(input.chainLogPath),
      error: loaded.error.message,
    });
  }

  const state = projectSprintState({
    sprint: input.sprint,
    execution: input.execution,
    tasks: input.tasks,
    chainLogEntries: entries,
    now: deps.clock(),
    ...(input.actualBranch !== undefined ? { actualBranch: input.actualBranch } : {}),
  });

  const content = renderProgressMarkdown(state);
  const wrote = await deps.writeFile(input.progressFile, content);
  if (!wrote.ok) {
    log?.warn('progress.md write failed', {
      path: String(input.progressFile),
      error: wrote.error.message,
    });
    return Result.error(wrote.error);
  }

  log?.debug('progress.md snapshot written', {
    path: String(input.progressFile),
    taskCount: input.tasks.length,
    logEntries: entries.length,
  });
  return Result.ok(undefined);
};
