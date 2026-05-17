import { promises as fs } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * On-disk layout of the ralphctl-v2 home directory:
 *
 *   <home>/.ralphctl-v2/
 *     data/                 ← root passed to persistence repositories
 *       projects/<id>.json
 *       sprints/<id>/{sprint,execution,tasks}.json
 *     config/               ← reserved for later (settings, profiles)
 *     state/                ← ephemeral coordination state (locks, run metadata)
 *       locks/              ← advisory file locks (per-sprint and per-repository)
 *
 * This module is the single source of truth for those paths. Composition root reads them at
 * startup and threads `dataRoot` into the persistence repository factories. `stateRoot` is
 * threaded into the harness chains for lock acquisition.
 *
 * Home override: `RALPHCTL_HOME` env var, when set to an absolute path, replaces the entire
 * `<home>/.ralphctl-v2` prefix. Useful for integration tests that spawn real subprocesses.
 */

export const APP_ROOT_DIR = '.ralphctl-v2';
export const DATA_SUBDIR = 'data';
export const CONFIG_SUBDIR = 'config';
export const STATE_SUBDIR = 'state';
export const LOCKS_SUBDIR = 'locks';
export const RALPHCTL_HOME_ENV = 'RALPHCTL_HOME';

export interface StoragePaths {
  /** `<home>/.ralphctl-v2` (or `$RALPHCTL_HOME`) — top-level app directory. */
  readonly appRoot: AbsolutePath;
  /** `<appRoot>/data` — root for persistence repositories (projects + sprints). */
  readonly dataRoot: AbsolutePath;
  /** `<appRoot>/config` — reserved for later. */
  readonly configRoot: AbsolutePath;
  /** `<appRoot>/state` — root for ephemeral coordination state. */
  readonly stateRoot: AbsolutePath;
  /** `<appRoot>/state/locks` — advisory file locks. */
  readonly locksRoot: AbsolutePath;
}

export interface ResolveStoragePathsDeps {
  /**
   * Override `os.homedir()` for tests. Defaults to the real home directory at call time so
   * production callers don't pass anything.
   */
  readonly homedir?: () => string;
  /**
   * Override `process.env` lookup for tests. Defaults to `process.env`. Set
   * `RALPHCTL_HOME` to bypass the `homedir` + `.ralphctl-v2` join.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Compute the canonical storage paths for the current user. Pure — does not touch the
 * filesystem. If `RALPHCTL_HOME` is set to an absolute path it overrides the default
 * `<home>/.ralphctl-v2` location; otherwise the standard layout under `homedir()` applies.
 * Combine with `ensureStorageRoots` to materialise the directory tree.
 */
export const resolveStoragePaths = (deps: ResolveStoragePathsDeps = {}): Result<StoragePaths, ValidationError> => {
  const env = deps.env ?? process.env;
  const override = env[RALPHCTL_HOME_ENV];
  if (typeof override === 'string' && override.length > 0) {
    const appRoot = AbsolutePath.parse(override);
    if (!appRoot.ok) return Result.error(appRoot.error);
    return storagePathsFromRoot(appRoot.value);
  }
  const home = (deps.homedir ?? osHomedir)();
  const appRoot = AbsolutePath.parse(join(home, APP_ROOT_DIR));
  if (!appRoot.ok) return Result.error(appRoot.error);
  return storagePathsFromRoot(appRoot.value);
};

/**
 * Build a `StoragePaths` from an arbitrary already-resolved app root. The seam tests use to
 * point the application at a tmp directory: `mkdtemp(...) → AbsolutePath.parse(...) →
 * storagePathsFromRoot(...)`. Pure — does not touch the filesystem.
 */
export const storagePathsFromRoot = (appRoot: AbsolutePath): Result<StoragePaths, ValidationError> => {
  const dataRoot = AbsolutePath.parse(join(String(appRoot), DATA_SUBDIR));
  if (!dataRoot.ok) return Result.error(dataRoot.error);
  const configRoot = AbsolutePath.parse(join(String(appRoot), CONFIG_SUBDIR));
  if (!configRoot.ok) return Result.error(configRoot.error);
  const stateRoot = AbsolutePath.parse(join(String(appRoot), STATE_SUBDIR));
  if (!stateRoot.ok) return Result.error(stateRoot.error);
  const locksRoot = AbsolutePath.parse(join(String(stateRoot.value), LOCKS_SUBDIR));
  if (!locksRoot.ok) return Result.error(locksRoot.error);
  return Result.ok({
    appRoot,
    dataRoot: dataRoot.value,
    configRoot: configRoot.value,
    stateRoot: stateRoot.value,
    locksRoot: locksRoot.value,
  }) as Result<StoragePaths, ValidationError>;
};

/**
 * Materialise the directory tree on disk. Idempotent — `mkdir -p` semantics. Creates the
 * full layout (app/data/config/state/locks + persistence subdirs) so a fresh checkout has
 * the expected shape even before anything is saved.
 */
export const ensureStorageRoots = async (paths: StoragePaths): Promise<Result<void, StorageError>> => {
  const dirs: readonly string[] = [
    String(paths.appRoot),
    String(paths.dataRoot),
    String(paths.configRoot),
    String(paths.stateRoot),
    String(paths.locksRoot),
    join(String(paths.dataRoot), 'projects'),
    join(String(paths.dataRoot), 'sprints'),
  ];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (cause) {
      return Result.error(new StorageError({ subCode: 'io', message: `mkdir failed: ${dir}`, path: dir, cause }));
    }
  }
  return Result.ok(undefined);
};
