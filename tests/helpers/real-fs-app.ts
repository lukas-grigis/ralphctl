/**
 * Real-filesystem `AppDeps` for tests. Materialises a tmp `RALPHCTL_HOME`, wires the full
 * production dependency graph against it, and returns helpers for sprint-directory assertions
 * + automatic cleanup.
 *
 * The point: tests built on this helper exercise the same persistence path the app uses in
 * production. A schema regression, a migration miss, or a port that silently stopped writing
 * surfaces here as a missing file or a parse failure — not as a green test against a mock repo
 * whose shape no longer matches reality.
 *
 * Usage:
 *
 *     const app = await createRealFsApp();
 *     try {
 *       renderView(<AddTicketView />, { deps: app.deps, ... });
 *       // ...drive the wizard...
 *       const sprintDir = app.sprintDir(sprintId);
 *       const snap = await readSprintDir(sprintDir);
 *       expect(snap.files['sprint.json']).toMatchObject({ tickets: [{ title: 'X' }] });
 *     } finally {
 *       await app.cleanup();
 *     }
 *
 * Or use `withRealFsApp(async (app) => { ... })` to skip the try/finally boilerplate.
 *
 * Spawn is stubbed to a no-op by default — tests that exercise the AI provider should pass
 * their own `spawn` to script provider stdout/exit. View-level tests don't need it.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  ensureStorageRoots,
  type StoragePaths,
  storagePathsFromRoot,
} from '@src/application/bootstrap/storage-paths.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { AppSinks } from '@src/application/bootstrap/runtime-sinks.ts';
import { nullSink } from '@src/integration/observability/sinks/null-sink.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

export interface RealFsApp {
  /** Tmp directory root (RALPHCTL_HOME equivalent). Cleaned up in `cleanup()`. */
  readonly home: AbsolutePath;
  /** Resolved storage paths (dataRoot, configRoot, stateRoot, ...). */
  readonly paths: StoragePaths;
  /** Production-wired AppDeps pointed at the tmp tree. */
  readonly deps: AppDeps;
  /** Absolute path to a sprint's directory: `<dataRoot>/sprints/<sprintId>/`. */
  readonly sprintDir: (id: SprintId) => string;
  /** Absolute path to `<dataRoot>/projects/`. */
  readonly projectsDir: string;
  /** Recursive `rm -rf` of the tmp tree. Idempotent. Call in `afterEach`. */
  readonly cleanup: () => Promise<void>;
}

export interface CreateRealFsAppOptions {
  /** Override settings (e.g. to switch provider). Default: `DEFAULT_SETTINGS`. */
  readonly settings?: Settings;
  /** Override harness sink. Default: `nullSink()` — drops every signal. */
  readonly sinks?: AppSinks;
  /**
   * Override spawn. Default: a no-op spawn that emits no stdout and exits 0 — sufficient for
   * any test that doesn't actually run a provider but where `wire()` still constructs one.
   * Tests that DO exercise a provider pass their own scripted spawn here.
   */
  readonly spawn?: ProviderSpawn;
}

/**
 * Materialise an isolated tmp app home + return a wired `AppDeps`. Caller is responsible for
 * calling `cleanup()` in `afterEach` (or use {@link withRealFsApp} to scope it automatically).
 */
export const createRealFsApp = async (options: CreateRealFsAppOptions = {}): Promise<RealFsApp> => {
  const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-realfs-'));
  const resolved = await realpath(raw);
  const home = AbsolutePath.parse(resolved);
  if (!home.ok) throw new Error(`tmp dir is not absolute: ${resolved}`);
  const paths = storagePathsFromRoot(home.value);
  if (!paths.ok) throw new Error(`storagePathsFromRoot failed: ${paths.error.message}`);
  await ensureStorageRoots(paths.value);

  const deps = wire({
    storage: paths.value,
    sinks: options.sinks ?? { harness: nullSink() },
    settings: options.settings ?? DEFAULT_SETTINGS,
    spawn: options.spawn ?? noopProviderSpawn,
  });

  return {
    home: home.value,
    paths: paths.value,
    deps,
    sprintDir: (id: SprintId) => join(String(paths.value.dataRoot), 'sprints', String(id)),
    projectsDir: join(String(paths.value.dataRoot), 'projects'),
    cleanup: async () => {
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
};

/**
 * Scope a `RealFsApp` to a callback. Cleanup runs even when the body throws — preferred over
 * manual try/finally because a missed cleanup leaks tmp dirs and breaks parallel test runs.
 */
export const withRealFsApp = async <T>(
  body: (app: RealFsApp) => Promise<T>,
  options: CreateRealFsAppOptions = {}
): Promise<T> => {
  const app = await createRealFsApp(options);
  try {
    return await body(app);
  } finally {
    await app.cleanup();
  }
};

/**
 * No-op provider spawn — synthesises a child that emits nothing and exits 0 on next tick.
 * Default for tests that don't exercise the AI path but where `wire()` still constructs a
 * provider eagerly. Real provider tests pass their own scripted spawn via
 * `CreateRealFsAppOptions.spawn`.
 */
const noopProviderSpawn: ProviderSpawn = (): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderr = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  (stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = (): void => {};
  (stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = (): void => {};
  Object.assign(child, {
    stdout,
    stderr,
    stdin: {
      end(_data: unknown): void {
        void _data;
      },
    },
    kill(): boolean {
      return true;
    },
  });
  setTimeout(() => child.emit('exit', 0, null), 0);
  return child;
};
