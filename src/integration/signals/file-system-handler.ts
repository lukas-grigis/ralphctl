/**
 * `FileSystemSignalHandler` — concrete `SignalHandlerPort` implementation.
 *
 * Routes parsed harness signals to durable filesystem destinations under
 * the new storage layout:
 *
 *  - `progress` / `note` / `task-blocked` → append timestamped markdown
 *    line to `<sprintDir>/progress.md` (under file lock to prevent
 *    concurrent corruption when parallel tasks emit simultaneously).
 *  - `evaluation` → write full critique to
 *    `<sprintDir>/evaluations/<task-id>.md` (overwrite per task) AND
 *    append a one-line summary to `progress.md`.
 *  - `task-verified` / `task-complete` → no durable write (use case layer
 *    owns task lifecycle in `tasks.json`).
 *  - `check-script-discovery` / `agents-md-proposal` → setup-time only,
 *    consumed inline by the caller.
 *
 * All writes are append-only or atomic-overwrite — a crash mid-write
 * leaves prior entries intact (resumability invariant).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SignalHandlerPort } from '../../business/ports/signal-handler-port.ts';
import { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import type { HarnessSignal } from '../../domain/signals/harness-signal.ts';
import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';
import type { TaskId } from '../../domain/values/task-id.ts';
import { FileLocker } from '../persistence/file-locker.ts';
import type { StoragePaths } from '../persistence/storage-paths.ts';

function progressPath(paths: StoragePaths, sprintId: SprintId): AbsolutePath {
  return AbsolutePath.trustString(join(paths.sprintDir(sprintId), 'progress.md'));
}

function evaluationPath(paths: StoragePaths, sprintId: SprintId, taskId: TaskId): AbsolutePath {
  return AbsolutePath.trustString(join(paths.sprintDir(sprintId), 'evaluations', `${taskId}.md`));
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

async function writeText(path: AbsolutePath, body: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body.endsWith('\n') ? body : `${body}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
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

  async handle(
    signal: HarnessSignal,
    ctx: { readonly sprintId: SprintId; readonly taskId?: TaskId }
  ): Promise<Result<void, StorageError>> {
    switch (signal.type) {
      case 'progress':
        return this.appendProgress(ctx.sprintId, formatProgress(signal.timestamp, signal.summary, signal.files));

      case 'note':
        return this.appendProgress(ctx.sprintId, formatProgress(signal.timestamp, `**Note:** ${signal.text}`));

      case 'task-blocked':
        return this.appendProgress(
          ctx.sprintId,
          formatProgress(signal.timestamp, `**Task Blocked:** ${signal.reason}`)
        );

      case 'evaluation': {
        if (ctx.taskId === undefined) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: 'evaluation signal requires taskId in context',
            })
          );
        }
        const file = evaluationPath(this.paths, ctx.sprintId, ctx.taskId);
        const body = renderEvaluationBody(signal);
        const w = await writeText(file, body);
        if (!w.ok) return w;
        return this.appendProgress(
          ctx.sprintId,
          formatProgress(
            signal.timestamp,
            `**Evaluation:** ${signal.status} (${String(signal.dimensions.length)} dimension(s))`
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

function renderEvaluationBody(signal: {
  readonly status: 'passed' | 'failed' | 'malformed';
  readonly dimensions: readonly { readonly dimension: string; readonly passed: boolean; readonly finding: string }[];
  readonly critique?: string;
  readonly timestamp: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Evaluation — ${signal.status}`);
  lines.push('');
  lines.push(`Recorded: ${signal.timestamp}`);
  lines.push('');
  if (signal.dimensions.length > 0) {
    lines.push('## Dimensions');
    lines.push('');
    for (const d of signal.dimensions) {
      const verdict = d.passed ? 'PASS' : 'FAIL';
      lines.push(`- **${d.dimension}**: ${verdict} — ${d.finding}`);
    }
    lines.push('');
  }
  if (signal.critique !== undefined && signal.critique.length > 0) {
    lines.push('## Critique');
    lines.push('');
    lines.push(signal.critique);
    lines.push('');
  }
  return lines.join('\n');
}
