import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';

/**
 * Entry-level working-tree snapshots and a path-scoped discard — what the implement flow needs to
 * tell which changes a setup script made, and to undo exactly those.
 *
 * The plain `gitStatusPorcelain` reader is not enough for that: its newline format quotes unusual
 * paths (`"sp ace.txt"`, octal escapes) and renders renames as `old -> new`, so its paths cannot be
 * handed back to git. The `-z` format used here keeps every path verbatim.
 */

/** One `git status --porcelain=v1 -z` record. */
export interface PorcelainEntry {
  /** The two status columns, e.g. `' M'`, `'??'`, `'R '`. */
  readonly xy: string;
  /** Repo-relative path, unquoted. An untracked directory ends in `/`. */
  readonly path: string;
  /** The source path of a rename or copy. */
  readonly origPath?: string;
}

/**
 * Comparison key: status columns plus path(s). A path whose status changes counts as a different
 * entry, so "setup further modified a file that was already dirty" and "setup newly dirtied it"
 * are told apart the same way the pre-`-z` check did.
 */
export const porcelainEntryKey = (entry: PorcelainEntry): string =>
  `${entry.xy}\0${entry.path}\0${entry.origPath ?? ''}`;

/** Every path an entry touches — both sides of a rename or copy. */
export const porcelainEntryPaths = (entry: PorcelainEntry): readonly string[] =>
  entry.origPath === undefined ? [entry.path] : [entry.path, entry.origPath];

/** The status columns start a record; the path follows a single separating space. */
const RECORD_PATH_OFFSET = 3;
/** Pathspecs per `restore` / `clean` call — keeps argv far below any platform's limit. */
const PATHSPECS_PER_CALL = 100;

const gitFailure = (verb: string, run: GitRunResult): StorageError =>
  new StorageError({ subCode: 'io', message: `git ${verb} failed: ${(run.stderr || run.stdout).trim()}` });

/** A rename or copy record is followed by one extra record holding the source path. */
const hasSourceRecord = (xy: string): boolean => /[RC]/.test(xy);

const parseRecords = (stdout: string): readonly PorcelainEntry[] => {
  const records = stdout.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? '';
    if (record.length <= RECORD_PATH_OFFSET) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(RECORD_PATH_OFFSET);
    if (!hasSourceRecord(xy)) {
      entries.push({ xy, path });
      continue;
    }
    i += 1;
    const origPath = records[i];
    entries.push(origPath !== undefined && origPath.length > 0 ? { xy, path, origPath } : { xy, path });
  }
  return entries;
};

/**
 * Every changed, staged and untracked entry in `cwd`. `--untracked-files=normal` overrides a
 * repo's `status.showUntrackedFiles=no` — generated files are exactly what callers look for, and
 * `git add -A` commits them whatever that setting says. A non-zero exit is an error, never "clean".
 */
export const gitStatusSnapshot = async (
  runner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<readonly PorcelainEntry[], StorageError>> => {
  const ran = await runner.run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!ran.ok) return Result.error(ran.error);
  if (ran.value.exitCode !== 0) return Result.error(gitFailure('status', ran.value));
  return Result.ok(parseRecords(ran.value.stdout));
};

const runChunked = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  verb: readonly string[],
  paths: readonly string[]
): Promise<Result<void, StorageError>> => {
  for (let start = 0; start < paths.length; start += PATHSPECS_PER_CALL) {
    const pathspecs = paths.slice(start, start + PATHSPECS_PER_CALL).map((p) => `:(literal)${p}`);
    const ran = await runner.run(cwd, [...verb, '--', ...pathspecs]);
    if (!ran.ok) return Result.error(ran.error);
    if (ran.value.exitCode !== 0) return Result.error(gitFailure(verb.join(' '), ran.value));
  }
  return Result.ok(undefined);
};

/**
 * Undo exactly `entries` in `cwd` and nothing else:
 *
 *  - tracked entries (modified, deleted, staged, renamed — both paths) go back to `HEAD` in the
 *    index and the working tree; a staged new file is removed;
 *  - untracked entries are deleted with `clean -f -d`, never `-x`, so ignored files (installed
 *    dependencies, build caches) survive.
 *
 * Paths are passed as `:(literal)` pathspecs, so glob characters in a file name match only that
 * file. `restore` fails on a path it cannot match; the first non-zero exit is returned as an error.
 * Callers should re-read the tree afterwards — a submodule or a nested repository can survive a
 * zero exit.
 */
export const gitDiscardEntries = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  entries: readonly PorcelainEntry[]
): Promise<Result<void, StorageError>> => {
  const tracked = entries.filter((e) => e.xy !== '??').flatMap(porcelainEntryPaths);
  const untracked = entries.filter((e) => e.xy === '??').map((e) => e.path);
  const restored = await runChunked(runner, cwd, ['restore', '--source=HEAD', '--staged', '--worktree'], tracked);
  if (!restored.ok) return restored;
  return runChunked(runner, cwd, ['clean', '-f', '-d'], untracked);
};
