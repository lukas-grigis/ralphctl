/**
 * `SignalHandlerPort` — durable persistence for parsed harness signals.
 *
 * Where `SignalBusPort` broadcasts signals to in-memory observers, the
 * handler writes them to disk (`progress.md`, `execution/<unit>/evaluation.md`,
 * etc.). One method covers all variants — the adapter dispatches on
 * `signal.type` internally so adding a new variant only forces one
 * switch to update, not a port-shape change.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

/**
 * Per-call metadata. `taskId` is required for evaluation writes;
 * `taskName` lets the handler derive the per-task execution unit slug
 * for evaluation sinks under `execution/<unit-slug>/evaluation.md`.
 */
export interface SignalHandlerMeta {
  readonly sprintId: SprintId;
  readonly taskId?: TaskId;
  readonly taskName?: string;
}

export interface SignalHandlerPort {
  /**
   * Persist a signal to its durable destination.
   *
   *  - `progress` / `note`     — append to `<sprintDir>/progress.md`.
   *  - `evaluation`            — write critique to
   *                              `<sprintDir>/execution/<unit-slug>/evaluation.md`;
   *                              append a one-line summary to `progress.md`.
   *  - `task-blocked`          — append to `progress.md`.
   *  - `task-complete` / `task-verified` — handled by the use case layer
   *                              (no durable write here).
   *  - `check-script-discovery` / `agents-md-proposal` etc — setup-time only;
   *                              consumed inline by the caller, not persisted.
   *
   * Append-only (or atomic-overwrite for evaluation) — a crash mid-write
   * leaves prior entries intact.
   */
  handle(signal: HarnessSignal, meta: SignalHandlerMeta): Promise<Result<void, StorageError>>;
}
