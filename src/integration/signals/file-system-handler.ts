/**
 * `FileSystemSignalHandler` — concrete `SignalHandlerPort` implementation.
 *
 * Routes parsed harness signals to durable filesystem destinations:
 *
 *  - `progress` / `note` / `task-blocked` → append timestamped markdown
 *    line to `<sprintDir>/progress.md` (under file lock to prevent
 *    concurrent corruption when parallel tasks emit simultaneously).
 *  - `evaluation` → append a one-line summary to `progress.md`. The
 *    full critique is persisted by `EvaluateAndFixLoopUseCase` via
 *    `WriteContextFilePort` (per-round file under
 *    `rounds/<N>/evaluator/evaluation.md` plus a stable
 *    `latest-evaluation.md` pointer) — this handler does NOT write
 *    the critique itself. Requires `taskId` plus `taskName` in the
 *    meta only for ergonomic logging; both fields remain validated
 *    so future per-task summary detail has a place to land without
 *    a contract change.
 *  - `task-verified` / `task-complete` → no durable write (use case layer
 *    owns task lifecycle in `tasks.json`).
 *  - `check-script-discovery` / `agents-md-proposal` etc → setup-time
 *    only, consumed inline by the caller.
 *
 * All writes are append-only or atomic-overwrite — a crash mid-write
 * leaves prior entries intact (resumability invariant).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SignalHandlerMeta, SignalHandlerPort } from '@src/business/ports/signal-handler-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { FileLocker } from '@src/integration/persistence/file-locker.ts';
import type { StoragePaths } from '@src/integration/persistence/storage-paths.ts';

function progressPath(paths: StoragePaths, sprintId: SprintId): AbsolutePath {
  return paths.progressFile(sprintId);
}

async function appendLine(path: AbsolutePath, line: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line.endsWith('\n') ? line : `${line}\n`, 'utf-8');
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to append to ${path}: ${err instanceof Error ? err.message : String(err)}`,
        path,
        cause: err,
      })
    );
  }
}

export class FileSystemSignalHandler implements SignalHandlerPort {
  constructor(
    private readonly paths: StoragePaths,
    private readonly fileLocker: FileLocker = new FileLocker()
  ) {}

  async handle(signal: HarnessSignal, meta: SignalHandlerMeta): Promise<Result<void, StorageError>> {
    switch (signal.type) {
      case 'progress':
        return this.appendProgress(meta.sprintId, formatProgress(signal.timestamp, signal.summary, signal.files));

      case 'note':
        return this.appendProgress(meta.sprintId, formatProgress(signal.timestamp, `**Note:** ${signal.text}`));

      case 'task-blocked':
        return this.appendProgress(
          meta.sprintId,
          formatProgress(signal.timestamp, `**Task Blocked:** ${signal.reason}`)
        );

      case 'evaluation': {
        if (meta.taskId === undefined) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: 'evaluation signal requires taskId in meta',
            })
          );
        }
        if (meta.taskName === undefined) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: 'evaluation signal requires taskName in meta',
            })
          );
        }
        // The full critique is persisted by `EvaluateAndFixLoopUseCase`
        // under `rounds/<N>/evaluator/evaluation.md` (plus a stable
        // `latest-evaluation.md` pointer). This handler only appends a
        // one-line summary to `progress.md` so the user can scan
        // verdicts in the sprint timeline without opening every round.
        const scoreSuffix = signal.overallScore !== undefined ? `, score ${String(signal.overallScore)}/5` : '';
        return this.appendProgress(
          meta.sprintId,
          formatProgress(
            signal.timestamp,
            `**Evaluation:** ${signal.status}${scoreSuffix} (${String(signal.dimensions.length)} dimension(s))`
          )
        );
      }

      // Use-case-owned signals: no durable write here.
      case 'task-verified':
      case 'task-complete':
        return Result.ok();

      // Setup-time signals: consumed inline by the setup / onboarding flow.
      case 'check-script-discovery':
      case 'agents-md-proposal':
      case 'setup-script':
      case 'verify-script':
      case 'skill-suggestions':
        return Result.ok();

      default: {
        const _exhaustive: never = signal;
        void _exhaustive;
        return Result.ok();
      }
    }
  }

  private async appendProgress(sprintId: SprintId, line: string): Promise<Result<void, StorageError>> {
    const path = progressPath(this.paths, sprintId);
    const locked = await this.fileLocker.withLock(path, () => appendLine(path, line));
    if (!locked.ok) return Result.error(locked.error);
    // Inner result is `Result<Result<void, StorageError>, StorageError>` — unwrap.
    return locked.value;
  }
}

function formatProgress(timestamp: string, message: string, files?: readonly string[]): string {
  const filesSuffix = files !== undefined && files.length > 0 ? ` (files: ${files.join(', ')})` : '';
  return `- ${timestamp} — ${message}${filesSuffix}`;
}
