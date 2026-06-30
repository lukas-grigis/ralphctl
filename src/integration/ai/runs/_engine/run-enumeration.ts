import { type Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Enumeration + parsing helpers for per-run forensic artifact directories under
 * `<dataRoot>/runs/<flow>/<run-id>/`. Used by the `ralphctl runs list` / `ralphctl runs prune`
 * CLI surface to inspect and tidy what the one-shot AI flows (detect-scripts / detect-skills /
 * readiness) leave on disk.
 *
 * All filesystem helpers swallow `ENOENT` on the supplied `runsRoot` and return `[]` so a
 * fresh install where the directory doesn't exist yet looks identical to an empty one — the
 * CLI prints an empty-state message in both cases. Parse helpers return `Result<…>` so
 * downstream callers can render a single clear error line and exit non-zero without scanning
 * the filesystem.
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
 * `YYYY-MM-DDTHH-MM-SS-mmmZ-<6-char-suffix>` (colons + dot replaced with `-`). We rebuild
 * the canonical ISO shape and `new Date(...)` it. Returns `null` (not an error) for names
 * that don't match the pattern — those are valid manual additions an operator may have made,
 * and the caller surfaces them as a warning rather than failing the scan.
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

/**
 * Parse a duration like `7d`, `24h`, `2w`. Suffixes are deliberately restricted to `h` / `d` /
 * `w` — minute granularity isn't useful when forensic dirs live for hours-to-weeks, and `m`
 * being ambiguous (minutes vs months) is a common foot-gun. The function returns a
 * `ValidationError` for negative, zero, NaN, unsupported suffix, or unparsable input so the
 * CLI can print a single clear error line before any filesystem access.
 */
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
 * Format an age relative to now in coarse buckets — seconds / minutes / hours / days / weeks.
 * `now` is injectable so tests get deterministic output.
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

/**
 * Enumerate every run dir under `runsRoot`. Returns one `RunEntry` per `<runsRoot>/<flow>/<run-id>/`
 * directory. ENOENT on `runsRoot` returns `[]`. Per-flow / per-run ENOENT (race with a concurrent
 * delete) is also tolerated — the affected entry is skipped. Other I/O errors propagate as
 * `Result.error`.
 *
 * Symbolic links are not followed: directory entries are filtered by `Dirent.isDirectory()` only,
 * and size accumulation uses `lstat`. Together this confines the scan to `runsRoot`.
 */
export const listRuns = async (runsRoot: AbsolutePath): Promise<Result<readonly RunEntry[], ValidationError>> => {
  const root = String(runsRoot);
  let flowDirs: Dirent[];
  try {
    flowDirs = await fs.readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === 'ENOENT') return Result.ok([]);
    return Result.error(
      new ValidationError({
        field: 'runs-root',
        value: root,
        message: `unable to read runs root: ${isErrnoException(cause) ? (cause.code ?? 'unknown') : 'unknown'}`,
      })
    );
  }

  const entries: RunEntry[] = [];
  for (const flowDir of flowDirs) {
    if (!flowDir.isDirectory()) continue;
    const flowPath = join(root, flowDir.name);
    let runDirs: Dirent[];
    try {
      runDirs = await fs.readdir(flowPath, { withFileTypes: true });
    } catch (cause) {
      if (isErrnoException(cause) && cause.code === 'ENOENT') continue;
      return Result.error(
        new ValidationError({
          field: 'runs-root',
          value: flowPath,
          message: `unable to read flow dir: ${isErrnoException(cause) ? (cause.code ?? 'unknown') : 'unknown'}`,
        })
      );
    }
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runPath = join(flowPath, runDir.name);
      const parsedPath = AbsolutePath.parse(runPath);
      if (!parsedPath.ok) continue;
      const sizeBytes = await computeDirSize(runPath);
      entries.push({
        flow: flowDir.name,
        runId: runDir.name,
        timestamp: parseRunTimestamp(runDir.name),
        sizeBytes,
        path: parsedPath.value,
      });
    }
  }
  return Result.ok(entries);
};

/**
 * Group entries by flow and sort within each group newest-first (parsed timestamp; entries
 * with `timestamp === null` sort last and keep stable lexicographic order between themselves
 * so an operator's `ls` output and the CLI agree).
 */
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

/**
 * Sum file sizes recursively under `dir`. Symlinks are not followed (we use `lstat`); per-entry
 * errors are swallowed and treated as zero so an unreadable file doesn't break the whole scan.
 */
const computeDirSize = async (dir: string): Promise<number> => {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await computeDirSize(entryPath);
      continue;
    }
    try {
      const stat = await fs.lstat(entryPath);
      if (stat.isFile()) total += stat.size;
    } catch {
      // best-effort; missing file in the middle of a scan is fine
    }
  }
  return total;
};

const compareNewestFirst = (a: RunEntry, b: RunEntry): number => {
  if (a.timestamp === null && b.timestamp === null) return a.runId.localeCompare(b.runId);
  if (a.timestamp === null) return 1;
  if (b.timestamp === null) return -1;
  return b.timestamp.getTime() - a.timestamp.getTime();
};

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === 'object' && cause !== null && 'code' in cause;
