import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';

/**
 * `StoragePaths` — the resolved on-disk layout described in
 * `ARCHITECTURE-NEXT.md § Storage layout`. Pure value object — no I/O. The
 * adapter calls {@link ensureLayoutDirs} when it needs the directory tree to
 * exist before a write.
 *
 * Layout:
 *
 * ```
 * <root>/
 * ├── config/
 * │   ├── config.json
 * │   └── projects.json
 * ├── data/sprints/<sprint-id>/
 * │   ├── sprint.json
 * │   └── tasks.json
 * ├── cache/
 * ├── logs/
 * └── backups/
 * ```
 */
export interface StoragePaths {
  readonly root: AbsolutePath;
  readonly configDir: AbsolutePath;
  readonly dataDir: AbsolutePath;
  readonly sprintsDir: AbsolutePath;
  readonly cacheDir: AbsolutePath;
  readonly logsDir: AbsolutePath;
  readonly backupsDir: AbsolutePath;

  readonly configFile: AbsolutePath;
  readonly projectsFile: AbsolutePath;

  sprintDir(id: SprintId): AbsolutePath;
  sprintFile(id: SprintId): AbsolutePath;
  tasksFile(id: SprintId): AbsolutePath;
}

export interface ResolveStoragePathsOptions {
  readonly root?: AbsolutePath;
}

function defaultRoot(): AbsolutePath {
  // RALPHCTL_ROOT may be a tilde-prefixed or relative path on the env, but
  // by the time we reach this layer the application has already validated
  // and normalised it. We accept any plain string the env hands us and brand
  // it via `trustString` — if we wanted to validate, we'd have done it at
  // the application boundary.
  const fromEnv = process.env['RALPHCTL_ROOT'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return AbsolutePath.trustString(fromEnv);
  }
  return AbsolutePath.trustString(join(homedir(), '.ralphctl'));
}

function asAbsolute(p: string): AbsolutePath {
  // Internal: each segment is joined onto an already-validated absolute root.
  return AbsolutePath.trustString(p);
}

export function resolveStoragePaths(opts: ResolveStoragePathsOptions = {}): StoragePaths {
  const root = opts.root ?? defaultRoot();
  const configDir = asAbsolute(join(root, 'config'));
  const dataDir = asAbsolute(join(root, 'data'));
  const sprintsDir = asAbsolute(join(dataDir, 'sprints'));
  const cacheDir = asAbsolute(join(root, 'cache'));
  const logsDir = asAbsolute(join(root, 'logs'));
  const backupsDir = asAbsolute(join(root, 'backups'));
  const configFile = asAbsolute(join(configDir, 'config.json'));
  const projectsFile = asAbsolute(join(configDir, 'projects.json'));

  return {
    root,
    configDir,
    dataDir,
    sprintsDir,
    cacheDir,
    logsDir,
    backupsDir,
    configFile,
    projectsFile,
    sprintDir(id: SprintId): AbsolutePath {
      return asAbsolute(join(sprintsDir, id));
    },
    sprintFile(id: SprintId): AbsolutePath {
      return asAbsolute(join(sprintsDir, id, 'sprint.json'));
    },
    tasksFile(id: SprintId): AbsolutePath {
      return asAbsolute(join(sprintsDir, id, 'tasks.json'));
    },
  };
}

/**
 * Idempotently create every layout directory. Called by adapters when they
 * are about to write — keeps `resolveStoragePaths` itself pure.
 */
export async function ensureLayoutDirs(paths: StoragePaths): Promise<void> {
  const dirs: readonly AbsolutePath[] = [
    paths.configDir,
    paths.sprintsDir,
    paths.cacheDir,
    paths.logsDir,
    paths.backupsDir,
  ];
  await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));
}

// Per-process memo of "have I already ensured the layout for this root?".
// Read-only paths (`--version`, `--help`, `completion show`) never trigger a
// write, so they never populate this map and never create directories.
//
// Keyed by `paths.root` because tests use unique tmp roots; we must not
// share a flag across roots or one test would mask another's state.
const ensuredRoots = new Map<string, Promise<void>>();

/**
 * Ensure the layout directories for `paths` exist. Memoised per root so
 * concurrent writes don't race the same `mkdir -p` work, and read-only
 * commands that never reach this code path don't pay for it.
 *
 * Tests can call {@link resetEnsureLayoutDirsCache} in `afterEach` to clear
 * the memo when a fresh tmp root is recycled across tests.
 */
export async function ensureLayoutDirsOnce(paths: StoragePaths): Promise<void> {
  const key = paths.root as unknown as string;
  const existing = ensuredRoots.get(key);
  if (existing !== undefined) return existing;
  const pending = ensureLayoutDirs(paths);
  ensuredRoots.set(key, pending);
  try {
    await pending;
  } catch (err) {
    // Don't cache a failed attempt — the caller may retry after fixing the
    // permission / disk issue.
    ensuredRoots.delete(key);
    throw err;
  }
}

/** Test-only: forget every memoised root so tests start from scratch. */
export function resetEnsureLayoutDirsCache(): void {
  ensuredRoots.clear();
}
