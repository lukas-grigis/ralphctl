import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { dirSizeBytes, removeDir } from '@src/integration/io/fs.ts';

/**
 * Enumeration + parsing helpers for per-run forensic artifact directories under `<dataRoot>/runs/<flow>/<run-id>/`.
 */

export interface RunEntry {
  /** Subdirectory immediately under `runsRoot` — e.g. `detect-scripts`, `readiness`. */
  readonly flow: string;
  /** Directory name under `runsRoot/<flow>/` — the value produced by `buildRunDirName`. */
  readonly runId: string;
  /** Parsed `Date` from the embedded ISO stamp, or `null` when the dir name is non-conforming. */
  readonly timestamp: Date | null;
  /** Total bytes under the run dir (file sizes summed; directory inodes ignored). */
  readonly sizeBytes: number;
  /** Absolute path to the run dir itself, suitable for downstream rm. */
  readonly path: AbsolutePath;
}

/**
 * Convert a `buildRunDirName` output back to a `Date`. The dir-name convention is
 * `YYYY-MM-DDTHH-MM-SS-mmmZ-<6-char-suffix>` (colons + dot replaced with `-`).
 */
export const parseRunTimestamp = (runDirName: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(runDirName);
  if (match === null) return null;
  const [, yyyy, mm, dd, hh, mi, ss, ms] = match;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const DURATION_HINT = 'use a value like 24h, 7d, or 2w';

/** Parse a duration like `7d`, `24h`, `2w`. */
export const parseDuration = (input: string): Result<number, ValidationError> => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return Result.error(
      new ValidationError({
        field: 'duration',
        value: input,
        message: 'duration must not be empty',
        hint: DURATION_HINT,
      })
    );
  }
  const match = /^(-?\d+(?:\.\d+)?)([a-zA-Z]+)$/.exec(trimmed);
  if (match === null) {
    return Result.error(
      new ValidationError({
        field: 'duration',
        value: input,
        message: `unparsable duration: ${input}`,
        hint: DURATION_HINT,
      })
    );
  }
  const [, numStr, suffix] = match;
  const num = Number(numStr);
  if (!Number.isFinite(num) || num <= 0) {
    return Result.error(
      new ValidationError({
        field: 'duration',
        value: input,
        message: `duration must be a positive number: ${input}`,
        hint: DURATION_HINT,
      })
    );
  }
  let unitMs: number;
  switch (suffix) {
    case 'h':
      unitMs = 60 * 60 * 1000;
      break;
    case 'd':
      unitMs = 24 * 60 * 60 * 1000;
      break;
    case 'w':
      unitMs = 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      return Result.error(
        new ValidationError({
          field: 'duration',
          value: input,
          message: `unsupported duration suffix '${suffix}'`,
          hint: 'supported suffixes are h (hours), d (days), w (weeks)',
        })
      );
  }
  return Result.ok(num * unitMs);
};

/** Format a byte count using binary units. Used in list rows and prune summaries. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[unitIndex]}`;
};

/**
 * Format an age relative to now in coarse buckets — seconds / minutes / hours / days / weeks. `now` is injectable so
 * tests get deterministic output.
 */
export const formatRelativeAge = (timestamp: Date | null, now: Date = new Date()): string => {
  if (timestamp === null) return 'unknown age';
  const deltaMs = now.getTime() - timestamp.getTime();
  if (deltaMs < 0) return 'in the future';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
};

/** Read a directory's entries, tolerating a missing path. */
const readDirTolerant = async (
  path: string,
  field: string
): Promise<Result<readonly Dirent[] | undefined, ValidationError>> => {
  try {
    return Result.ok(await fs.readdir(path, { withFileTypes: true }));
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === 'ENOENT') return Result.ok(undefined);
    return Result.error(
      new ValidationError({
        field,
        value: path,
        message: `unable to read ${field}: ${isErrnoException(cause) ? (cause.code ?? 'unknown') : 'unknown'}`,
      })
    );
  }
};

/** Enumerate every run dir under one flow directory (`<runsRoot>/<flowName>/`). */
const listRunsForFlow = async (
  root: string,
  flowName: string
): Promise<Result<readonly RunEntry[], ValidationError>> => {
  const flowPath = join(root, flowName);
  const runDirs = await readDirTolerant(flowPath, 'flow-dir');
  if (!runDirs.ok) return Result.error(runDirs.error);
  if (runDirs.value === undefined) return Result.ok([]);

  const entries: RunEntry[] = [];
  for (const runDir of runDirs.value) {
    if (!runDir.isDirectory()) continue;
    const runPath = join(flowPath, runDir.name);
    const parsedPath = AbsolutePath.parse(runPath);
    if (!parsedPath.ok) continue;
    const sizeBytes = await dirSizeBytes(runPath);
    entries.push({
      flow: flowName,
      runId: runDir.name,
      timestamp: parseRunTimestamp(runDir.name),
      sizeBytes,
      path: parsedPath.value,
    });
  }
  return Result.ok(entries);
};

/**
 * Enumerate every run dir under `runsRoot`. Returns one `RunEntry` per `<runsRoot>/<flow>/<run-id>/` directory.
 */
export const listRuns = async (runsRoot: AbsolutePath): Promise<Result<readonly RunEntry[], ValidationError>> => {
  const root = String(runsRoot);
  const flowDirs = await readDirTolerant(root, 'runs-root');
  if (!flowDirs.ok) return Result.error(flowDirs.error);
  if (flowDirs.value === undefined) return Result.ok([]);

  const entries: RunEntry[] = [];
  for (const flowDir of flowDirs.value) {
    if (!flowDir.isDirectory()) continue;
    const forFlow = await listRunsForFlow(root, flowDir.name);
    if (!forFlow.ok) return Result.error(forFlow.error);
    entries.push(...forFlow.value);
  }
  return Result.ok(entries);
};

const isPlainSegment = (segment: string): boolean =>
  segment.length > 0 && segment !== '.' && segment !== '..' && !/[/\\\0]/.test(segment);

/**
 * Delete one run dir `<runsRoot>/<flow>/<runId>/`. Both names must be single path segments, so the delete can never
 * escape `runsRoot`.
 */
export const removeRun = async (
  runsRoot: AbsolutePath,
  run: { readonly flow: string; readonly runId: string }
): Promise<Result<void, NotFoundError | StorageError>> => {
  if (!isPlainSegment(run.flow) || !isPlainSegment(run.runId)) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `refusing to delete run outside the runs root: ${run.flow}/${run.runId}`,
      })
    );
  }
  return removeDir(join(String(runsRoot), run.flow, run.runId));
};

/** Group entries by flow and sort within each group newest-first (parsed timestamp. */
export const groupByFlow = (entries: readonly RunEntry[]): Map<string, readonly RunEntry[]> => {
  const groups = new Map<string, RunEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.flow);
    if (bucket === undefined) groups.set(entry.flow, [entry]);
    else bucket.push(entry);
  }
  for (const [flow, bucket] of groups) {
    bucket.sort(compareNewestFirst);
    groups.set(flow, bucket);
  }
  return new Map(Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b)));
};

const compareNewestFirst = (a: RunEntry, b: RunEntry): number => {
  if (a.timestamp === null && b.timestamp === null) return a.runId.localeCompare(b.runId);
  if (a.timestamp === null) return 1;
  if (b.timestamp === null) return -1;
  return b.timestamp.getTime() - a.timestamp.getTime();
};

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === 'object' && cause !== null && 'code' in cause;
