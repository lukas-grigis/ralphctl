/**
 * `SignalHandlerPort` — durable persistence for parsed harness signals.
 *
 * Where `SignalBusPort` broadcasts signals to in-memory observers, the
 * handler writes them to disk (progress.md, evaluations/<task>.md, etc.).
 * One method covers all variants — the adapter dispatches on
 * `signal.type` internally so adding a new variant only forces one switch
 * to update, not a port-shape change.
 */
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

export interface SignalHandlerPort {
  /**
   * Persist a signal to its durable destination.
   *
   *  - `progress` / `note`     — append to `progress.md`.
   *  - `evaluation`            — append to `evaluations/<taskId>.md`; mirror
   *                              a 2000-char preview into `tasks.json`.
   *  - `task-blocked`          — append to `progress.md`.
   *  - `task-complete` / `task-verified` — handled by the use case layer
   *                              (no durable write here).
   *  - `check-script-discovery` / `agents-md-proposal` — setup-time only;
   *                              consumed inline by the caller, not persisted.
   *
   * Append-only: a crash mid-write leaves prior entries intact.
   */
  handle(
    signal: HarnessSignal,
    ctx: { readonly sprintId: SprintId; readonly taskId?: TaskId }
  ): Promise<Result<void, StorageError>>;
}
