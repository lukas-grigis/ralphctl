/**
 * `ralphctl demo` — zero-setup entry point: seeds an isolated, marker-guarded sandbox
 * (`<tmpdir>/ralphctl-demo` by default) with the same "hello-python" mock project
 * `scripts/seed-mock.ts` builds (via the shared `seedDemoWorkspace`, #228), writes a
 * `settings.json` so the welcome flow never fires, then launches the TUI pointed at the sandbox.
 *
 * Wipe policy: the sandbox is reseeded from scratch on every run, but ONLY when the target
 * directory either doesn't exist yet or carries the `.ralphctl-demo` marker this command (or
 * `pnpm mock`) itself wrote — a directory that exists but lacks the marker is refused outright,
 * so pointing `--home` at an unrelated directory can never destroy it.
 *
 * `DemoOptions` is deliberately a small, flat options object (mirroring every other command
 * action in this directory) rather than positional args threaded ad hoc.
 *
 * `--script` layers the recording mode on top: same sandbox, but the AI adapters are pointed at a
 * canned generator → evaluator transcript instead of a real CLI, so the run needs no provider
 * install and no auth. See `src/application/demo/scripted-run.ts` for what it pins and why.
 */

import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { RALPHCTL_HOME_ENV, storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { DEMO_MARKER_FILENAME, type SeedDemoSummary, seedDemoWorkspace } from '@src/application/demo/seed.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { launchTui } from '@src/application/ui/tui/launch.ts';
import { fail } from '@src/application/ui/cli/report-cli-error.ts';
import { prepareScriptedDemo } from '@src/application/demo/scripted-run.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

interface DemoOptions {
  readonly home?: string;
  readonly launch: boolean;
  /** Replay the canned transcript instead of spawning a real AI CLI — see `prepareScriptedDemo`. */
  readonly script?: boolean;
}

const DEFAULT_DEMO_HOME = join(tmpdir(), 'ralphctl-demo');

const pathExists = async (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

/**
 * Refuses to touch a directory that exists but wasn't created by this command (no marker file).
 * Returns an error string on refusal, `undefined` when it's safe to proceed (and has already
 * wiped an existing marker-bearing sandbox).
 */
const prepareSandbox = async (homeDirStr: string): Promise<string | undefined> => {
  if (!(await pathExists(homeDirStr))) return undefined;
  const hasMarker = await pathExists(join(homeDirStr, DEMO_MARKER_FILENAME));
  if (!hasMarker) {
    return (
      `${homeDirStr} already exists and was not created by 'ralphctl demo' ` +
      `(no ${DEMO_MARKER_FILENAME} marker) — refusing to wipe it. Pass --home <dir> to pick an ` +
      'empty or demo-owned directory instead.'
    );
  }
  await fs.rm(homeDirStr, { recursive: true, force: true });
  return undefined;
};

/** Skip the welcome flow entirely — the sandbox always opens straight to home / create-project. */
const seedSandboxSettings = async (homeDir: AbsolutePath): Promise<void> => {
  const paths = storagePathsFromRoot(homeDir);
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);
  const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
  const saved = await settingsRepo.save(DEFAULT_SETTINGS);
  if (!saved.ok) throw new Error(`settings: ${saved.error.message}`);
};

const printSummary = (summary: SeedDemoSummary, homeDirStr: string): void => {
  const line = '─'.repeat(60);
  process.stdout.write(
    [
      '',
      line,
      '  Demo workspace seeded ✓',
      line,
      `  home    : ${homeDirStr}`,
      `  repo    : ${String(summary.repoDir)}  (git-initialised, python3 hello.py)`,
      `  project : ${summary.projectName}`,
      '',
      '  Sprints:',
      ...summary.sprints.map((s) => `    • "${s.name}"  ${s.state}`),
      line,
      '',
    ].join('\n')
  );
};

const demoAction = async (opts: DemoOptions): Promise<void> => {
  const homeDirStr = opts.home ?? DEFAULT_DEMO_HOME;
  const homeDir = AbsolutePath.parse(homeDirStr);
  if (!homeDir.ok) {
    fail(`--home must be an absolute path: ${homeDirStr}`);
    return;
  }

  const refusal = await prepareSandbox(homeDirStr);
  if (refusal !== undefined) {
    fail(refusal);
    return;
  }

  const seeded = await seedDemoWorkspace(
    { runCommand, writeFile: createAtomicWriteFile() },
    { homeDir: homeDir.value, token: randomUUID().slice(0, 8) }
  );
  if (!seeded.ok) {
    fail(`seeding failed: ${seeded.error.message}`);
    return;
  }

  await seedSandboxSettings(homeDir.value);

  // Scripted mode rewrites the settings this just wrote (claude-only rows, escalation rungs off)
  // and repoints the seeded verify script / acceptance criterion at portable node one-liners.
  // Last write wins by design — the plain-mode settings above are the fallback shape.
  let providerSpawn: ProviderSpawn | undefined;
  if (opts.script === true) {
    const scripted = await prepareScriptedDemo({ homeDir: homeDir.value });
    if (!scripted.ok) {
      fail(`scripted demo setup failed: ${scripted.error.message}`);
      return;
    }
    providerSpawn = scripted.value.providerSpawn;
  }

  printSummary(seeded.value, homeDirStr);
  if (opts.script === true) {
    process.stdout.write(
      '  Scripted mode: every AI row is pinned to claude-code and replays a canned two-round\n' +
        '  generator → evaluator transcript. No provider CLI is spawned; the verify script and\n' +
        '  acceptance criterion are rewritten to portable node one-liners.\n' +
        '  The transcript covers the Implement flow — the "ready to implement" sprint is the one\n' +
        '  to launch. Interactive flows (refine / plan / ideate) still need a real, authenticated\n' +
        '  provider CLI, in demo mode too.\n\n'
    );
  }

  if (!opts.launch) {
    process.stdout.write(
      `Launch it with:\n\n  RALPHCTL_HOME=${homeDirStr} ralphctl\n\n` +
        (opts.script === true
          ? `Or reproduce the whole scripted run:\n\n  ralphctl demo --script --home ${homeDirStr}\n\n`
          : '')
    );
    return;
  }

  process.stdout.write(
    opts.script === true
      ? 'Launching the TUI against the sandbox with the scripted transcript…\n\n'
      : 'Launching the TUI against the sandbox…\n\n'
  );
  // `resolveStoragePaths()` (inside `launchTui`) reads `RALPHCTL_HOME` per call — setting the
  // env var here is enough to redirect the launch, no child process needed.
  process.env[RALPHCTL_HOME_ENV] = homeDirStr;
  await launchTui({ ...(providerSpawn !== undefined ? { providerSpawn } : {}) });
};

/**
 * Register the `demo` CLI command.
 *
 *   ralphctl demo                    # seed + launch the sandbox
 *   ralphctl demo --no-launch        # seed only, print the launch command
 *   ralphctl demo --home /tmp/foo    # custom sandbox directory
 *   ralphctl demo --script           # replay the canned transcript — no provider CLI, no auth
 */
export const registerDemoCommand = (program: Command): void => {
  program
    .command('demo')
    .description('seed a throwaway sandbox project and launch the TUI against it — zero setup required')
    .option('--home <dir>', 'sandbox directory (default: a fixed path under the OS tmp dir)')
    .option('--no-launch', 'seed only — print the launch command instead of opening the TUI')
    .option('--script', 'replay a canned generator/evaluator transcript instead of spawning a real AI CLI')
    .action(demoAction);
};
