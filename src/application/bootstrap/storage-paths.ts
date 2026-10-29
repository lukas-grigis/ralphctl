import { promises as fs } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * The single source of truth for the ralphctl home layout (entry naming inside `data/` is in
 * `.claude/docs/ARCHITECTURE.md`):
 *
 *   <home>/.ralphctl/          ← or `$RALPHCTL_HOME` (absolute; an unexpanded `${VAR}` / `$(cmd)` is refused)
 *     data/                    ← persistence root: projects/, sprints/, runs/, memory/
 *     config/                  ← settings.json
 *     state/locks/             ← advisory file locks
 *     skills/  agents/         ← operator drop-ins
 */

export const APP_ROOT_DIR = '.ralphctl';
export const DATA_SUBDIR = 'data';
export const CONFIG_SUBDIR = 'config';
export const STATE_SUBDIR = 'state';
export const LOCKS_SUBDIR = 'locks';
export const RUNS_SUBDIR = 'runs';
export const MEMORY_SUBDIR = 'memory';
export const SKILLS_SUBDIR = 'skills';
export const AGENTS_SUBDIR = 'agents';
export const RALPHCTL_HOME_ENV = 'RALPHCTL_HOME';

/** `${VAR}` / `$(cmd)` left by a single-quoted export or `.env` loader; bare `$name` stays legal (`/srv/$build`). */
const UNEXPANDED_SHELL_REGEX = /\$\{[^}]*\}|\$\(/;

export interface StoragePaths {
  /** `<home>/.ralphctl` (or `$RALPHCTL_HOME`) — top-level app directory. */
  readonly appRoot: AbsolutePath;
  /** `<appRoot>/data` — root for persistence repositories (projects + sprints). */
  readonly dataRoot: AbsolutePath;
  /** `<appRoot>/config` — `settings.json`. */
  readonly configRoot: AbsolutePath;
  /** `<appRoot>/state` — root for ephemeral coordination state. */
  readonly stateRoot: AbsolutePath;
  /** `<appRoot>/state/locks` — advisory file locks. */
  readonly locksRoot: AbsolutePath;
  /**
   * `<dataRoot>/runs/<flow>/<run-id>/` — forensic artifacts (rendered prompt, raw AI body) of the
   * one-shot flows. User-managed lifecycle: never auto-collected.
   */
  readonly runsRoot: AbsolutePath;
  /** `<dataRoot>/memory` — per-project learnings ledgers; under `data/` because they outlive sprints. */
  readonly memoryRoot: AbsolutePath;
  /**
   * `<appRoot>/skills/<providerDir>/<name>/SKILL.md` — operator drop-in skills, installed like the
   * bundled ones. Not created by `ensureStorageRoots`: a missing dir is a valid empty source.
   */
  readonly operatorSkillsRoot: AbsolutePath;
  /** `<appRoot>/agents/<name>.md` — provider-agnostic operator agent definitions; not created either. */
  readonly operatorAgentDefinitionsRoot: AbsolutePath;
}

export interface ResolveStoragePathsDeps {
  /**
   * Override `os.homedir()` for tests. Defaults to the real home directory at call time so
   * production callers don't pass anything.
   */
  readonly homedir?: () => string;
  /**
   * Override `process.env` lookup for tests. Defaults to `process.env`. Set
   * `RALPHCTL_HOME` to bypass the `homedir` + `.ralphctl` join.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Compute the canonical storage paths for the current user. Pure — does not touch the
 * filesystem. If `RALPHCTL_HOME` is set to an absolute path it overrides the default
 * `<home>/.ralphctl` location; otherwise the standard layout under `homedir()` applies.
 * Combine with `ensureStorageRoots` to materialise the directory tree.
 */
export const resolveStoragePaths = (deps: ResolveStoragePathsDeps = {}): Result<StoragePaths, ValidationError> => {
  const env = deps.env ?? process.env;
  const override = env[RALPHCTL_HOME_ENV];
  if (typeof override === 'string' && override.length > 0) {
    // Checked here, not in AbsolutePath: a repo dir may legally contain `${...}`, but this value creates the tree.
    if (UNEXPANDED_SHELL_REGEX.test(override)) {
      return Result.error(
        new ValidationError({
          field: RALPHCTL_HOME_ENV,
          value: override,
          message: `${RALPHCTL_HOME_ENV} looks unexpanded: '${override}'`,
          hint: 'expand ${VAR} / $(cmd) in your shell or .env loader before launching',
        })
      );
    }
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
  const dataRoot = child(appRoot, DATA_SUBDIR);
  const stateRoot = child(appRoot, STATE_SUBDIR);
  return Result.ok({
    appRoot,
    dataRoot,
    configRoot: child(appRoot, CONFIG_SUBDIR),
    stateRoot,
    locksRoot: child(stateRoot, LOCKS_SUBDIR),
    runsRoot: child(dataRoot, RUNS_SUBDIR),
    memoryRoot: child(dataRoot, MEMORY_SUBDIR),
    operatorSkillsRoot: child(appRoot, SKILLS_SUBDIR),
    operatorAgentDefinitionsRoot: child(appRoot, AGENTS_SUBDIR),
  });
};

/** A fixed segment joined onto an absolute path is always absolute, so the throw is unreachable. */
const child = (base: AbsolutePath, name: string): AbsolutePath => {
  const path = AbsolutePath.parse(join(String(base), name));
  if (!path.ok) throw path.error;
  return path.value;
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
    String(paths.runsRoot),
    String(paths.memoryRoot),
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
