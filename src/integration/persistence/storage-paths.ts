import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';

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
