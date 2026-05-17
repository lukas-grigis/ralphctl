/**
 * In-process CLI harness. Boots a fresh `RALPHCTL_HOME` for every call, mocks
 * `process.exit` so a command's exit code is captured rather than terminating the test
 * runner, and tees `process.stdout` / `process.stderr` writes into strings.
 *
 * Use directly:
 *
 *     const home = await createCliHome();
 *     try {
 *       const r = await runCliCaptured(home, ['ralphctl', 'doctor']);
 *       expect(r.exitCode).toBe(0);
 *       expect(r.stdout).toContain('OK');
 *     } finally {
 *       await home.cleanup();
 *     }
 *
 * Or via the `withCliHome` block helper, which handles teardown.
 *
 * The `node` argv slot is conventional — commander expects `[node, scriptPath, ...args]`.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import {
  ensureStorageRoots,
  storagePathsFromRoot,
  type StoragePaths,
  RALPHCTL_HOME_ENV,
} from '@src/application/bootstrap/storage-paths.ts';
import { runCli } from '@src/application/ui/cli/cli.ts';

export interface CliHome {
  readonly home: AbsolutePath;
  readonly paths: StoragePaths;
  readonly cleanup: () => Promise<void>;
}

/**
 * Materialise an isolated `RALPHCTL_HOME` under the OS tmp dir + create the standard storage
 * subtree. Caller is responsible for `cleanup()` (typically in `afterEach`).
 */
export const createCliHome = async (): Promise<CliHome> => {
  const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-cli-e2e-'));
  const resolved = await realpath(raw);
  const home = AbsolutePath.parse(resolved);
  if (!home.ok) throw new Error(`tmp dir is not absolute: ${resolved}`);
  const paths = storagePathsFromRoot(home.value);
  if (!paths.ok) throw new Error(`storagePathsFromRoot failed: ${paths.error.message}`);
  await ensureStorageRoots(paths.value);
  return {
    home: home.value,
    paths: paths.value,
    cleanup: async () => fs.rm(resolved, { recursive: true, force: true }),
  };
};

export interface CliCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the CLI in-process against the supplied tmp home. Captures stdout/stderr writes and
 * the (first) `process.exit` code. Restores all spies on completion. Default exit code is 0
 * — commands that print successfully and never call `exit` (e.g. `completion`) come back
 * with `exitCode: 0`.
 */
export const runCliCaptured = async (cli: CliHome, argv: readonly string[]): Promise<CliCapture> => {
  const previousHome = process.env[RALPHCTL_HOME_ENV];
  process.env[RALPHCTL_HOME_ENV] = String(cli.home);

  let exitCode = 0;
  let exitCalled = false;
  let stdout = '';
  let stderr = '';

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    if (!exitCalled) {
      exitCalled = true;
      exitCode = typeof code === 'number' ? code : 0;
    }
    return undefined as never;
  });
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });

  try {
    await runCli(['node', 'ralphctl', ...argv]);
  } catch (cause) {
    // Commander exits the process on parse errors (`--help`, unknown command). With
    // `process.exit` mocked the error path falls through to here as a regular throw or as a
    // commander-internal error. Treat it as a non-zero exit if `exit` wasn't recorded.
    if (!exitCalled) {
      exitCalled = true;
      exitCode = 1;
      stderr += `${(cause as Error).message ?? String(cause)}\n`;
    }
  } finally {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (previousHome === undefined) delete process.env[RALPHCTL_HOME_ENV];
    else process.env[RALPHCTL_HOME_ENV] = previousHome;
  }

  return { exitCode, stdout, stderr };
};
