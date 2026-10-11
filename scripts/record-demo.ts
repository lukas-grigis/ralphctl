/**
 * README capture of the generator → evaluator loop (#220): seeds a demo sandbox, pins it to the
 * paced `ralphctl demo --script` transcript and launches the TUI. `.github/assets/demo.tape` drives
 * it under VHS.
 *
 *   pnpm demo:record [--home /abs/dir] [--delay 1500]
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { RALPHCTL_HOME_ENV, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { DEMO_MARKER_FILENAME, seedDemoWorkspace } from '@src/application/demo/seed.ts';
import { prepareScriptedDemo } from '@src/application/demo/scripted-run.ts';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

// ~6s run: round 1's "✗ correctness" row stays readable through round 2, capture stays ≤10s.
const DEFAULT_SESSION_DELAY_MS = 1000;

/** Fixed slug token so every recording shows the same project / sprint names. */
const RECORDING_TOKEN = 'readme';

/** @public */
export const RECORDING_SETUP_SCRIPT = 'node --version';

const DEFAULT_HOME = join(tmpdir(), 'ralphctl-readme-demo');

export interface PrepareRecordingInput {
  /** Sandbox app root. Wiped and reseeded — refused unless empty or carrying the demo marker. */
  readonly homeDir: AbsolutePath;
  readonly sessionDelayMs?: number;
  /** Clock for the transcript's signal timestamps. Tests pin it. */
  readonly now?: () => IsoTimestamp;
}

export interface PreparedRecording {
  readonly providerSpawn: ProviderSpawn;
  readonly repoDir: AbsolutePath;
}

/** Same guard as `ralphctl demo`: never wipe a directory this tooling did not create. */
const resetSandbox = async (homeDir: AbsolutePath): Promise<Result<void, DomainError>> => {
  const home = String(homeDir);
  const refuse = (reason: string, cause?: unknown): Result<void, DomainError> =>
    Result.error(
      new StorageError({
        subCode: 'io',
        path: home,
        message: `${home} ${reason} — refusing to wipe it`,
        hint: 'pass --home <dir> pointing at an empty or demo-owned directory',
        ...(cause !== undefined ? { cause } : {}),
      })
    );
  let entries: string[];
  try {
    entries = await fs.readdir(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Result.ok(undefined);
    // A file (ENOTDIR) or unreadable dir is never a demo sandbox.
    return refuse('is not a readable directory', error);
  }
  if (entries.length > 0 && !entries.includes(DEMO_MARKER_FILENAME)) {
    return refuse(`exists and was not created by the demo seeder (no ${DEMO_MARKER_FILENAME})`);
  }
  await fs.rm(home, { recursive: true, force: true });
  return Result.ok(undefined);
};

/** A setup script silences the "No setup script" warning that would sit under the task all capture. */
const withRecordingSetupScript = async (homeDir: AbsolutePath): Promise<Result<void, DomainError>> => {
  const paths = storagePathsFromRoot(homeDir);
  if (!paths.ok) return Result.error(paths.error);
  const projectRepo = createFsProjectRepository({ root: paths.value.dataRoot });
  const projects = await projectRepo.list();
  if (!projects.ok) return Result.error(projects.error);
  for (const project of projects.value) {
    const saved = await projectRepo.save({
      ...project,
      repositories: project.repositories.map((repo) => ({ ...repo, setupScript: RECORDING_SETUP_SCRIPT })),
    });
    if (!saved.ok) return Result.error(saved.error);
  }
  return Result.ok(undefined);
};

/**
 * Seed a fresh sandbox and return the paced scripted spawn for `launchTui` (or `wire()` in the test).
 *
 * @public
 */
export const prepareRecording = async (
  input: PrepareRecordingInput
): Promise<Result<PreparedRecording, DomainError>> => {
  const reset = await resetSandbox(input.homeDir);
  if (!reset.ok) return Result.error(reset.error);

  const seeded = await seedDemoWorkspace(
    { runCommand, writeFile: createAtomicWriteFile() },
    { homeDir: input.homeDir, token: RECORDING_TOKEN }
  );
  if (!seeded.ok) return Result.error(seeded.error);

  const scripted = await prepareScriptedDemo({
    homeDir: input.homeDir,
    sessionDelayMs: input.sessionDelayMs ?? DEFAULT_SESSION_DELAY_MS,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!scripted.ok) return Result.error(scripted.error);

  const setup = await withRecordingSetupScript(input.homeDir);
  if (!setup.ok) return Result.error(setup.error);

  return Result.ok({ providerSpawn: scripted.value.providerSpawn, repoDir: seeded.value.repoDir });
};

const parseCli = (argv: readonly string[]): { readonly home: string; readonly delayMs: number } => {
  const { values } = parseArgs({
    args: [...argv],
    options: { home: { type: 'string' }, delay: { type: 'string' } },
  });
  const delayMs = values.delay === undefined ? DEFAULT_SESSION_DELAY_MS : Number(values.delay);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`--delay must be a non-negative number of ms`);
  return { home: resolve(values.home ?? DEFAULT_HOME), delayMs };
};

const main = async (argv: readonly string[]): Promise<number> => {
  const { home, delayMs } = parseCli(argv);
  const homeDir = AbsolutePath.parse(home);
  if (!homeDir.ok) throw homeDir.error;

  const prepared = await prepareRecording({ homeDir: homeDir.value, sessionDelayMs: delayMs });
  if (!prepared.ok) {
    process.stderr.write(`record-demo: ${prepared.error.message}\n`);
    return 1;
  }

  // `launchTui` resolves storage from `RALPHCTL_HOME` per call — same redirect `ralphctl demo` uses.
  process.env[RALPHCTL_HOME_ENV] = home;
  await launchTui({ providerSpawn: prepared.value.providerSpawn });
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
};

// ESM main-module guard (same idiom as scripts/eval/main.ts): run only when invoked directly,
// never when a test imports this module.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  process.exitCode = await main(process.argv.slice(2));
}
