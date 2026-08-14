/**
 * `seed-mock.ts` — generate a ready-to-drive mock project so you can exercise the
 * refine / plan / implement flows without the manual setup ceremony every time.
 *
 * Repeatably executable: wipes and regenerates a sandbox `RALPHCTL_HOME` plus a throwaway
 * "hello world" Python git repo, seeds one project and three sprints — each parked in exactly
 * the state one flow expects — then (by default) launches the TUI pointed at the sandbox so you
 * can select a sprint and take off.
 *
 *   pnpm mock                            # sandbox home defaults to /tmp/ralphctl-mock
 *   RALPHCTL_HOME=/tmp/foo pnpm mock     # custom sandbox home
 *   RALPHCTL_MOCK_NO_LAUNCH=1 pnpm mock  # seed only — print the launch command, don't open the TUI
 *
 * The actual seeding (project + repo + three sprints) lives in `src/application/demo/seed.ts` —
 * this script is a thin env-var-driven wrapper around `seedDemoWorkspace`, shared with the
 * shipped `ralphctl demo` command so the two surfaces can never drift (#228).
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { seedDemoWorkspace } from '@src/application/demo/seed.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Short per-run token — keeps project / sprint / repo names distinct across runs. */
const TOKEN = randomUUID().slice(0, 8);

/**
 * Sandbox app-root. When `RALPHCTL_HOME` is set we honour it and seed ADDITIVELY (the token
 * keeps every run's slugs collision-free), so an explicit home accumulates fresh mock projects
 * and is never wiped — only a home WE generated under the tmp dir gets blown away on rerun.
 */
const EXPLICIT_HOME = process.env.RALPHCTL_HOME;
const HOME_DIR = EXPLICIT_HOME ?? join(tmpdir(), `ralphctl-mock-${TOKEN}`);

const main = async (): Promise<void> => {
  // Repeatable: blow away the sandbox before regenerating — but ONLY a home we generated
  // ourselves under the tmp dir. An explicit RALPHCTL_HOME is seeded additively and never wiped,
  // so pointing this at a real-ish store can't destroy existing data.
  if (EXPLICIT_HOME === undefined) {
    await fs.rm(HOME_DIR, { recursive: true, force: true });
  }

  const homeDir = AbsolutePath.parse(HOME_DIR);
  if (!homeDir.ok) throw new Error(`RALPHCTL_HOME is not an absolute path: ${HOME_DIR}`);

  const result = await seedDemoWorkspace(
    { runCommand, writeFile: createAtomicWriteFile() },
    { homeDir: homeDir.value, token: TOKEN }
  );
  if (!result.ok) {
    throw new Error(`seeding failed: ${result.error.message}`);
  }
  const summary = result.value;

  const line = '─'.repeat(60);
  process.stdout.write(
    [
      '',
      line,
      '  Mock project seeded ✓',
      line,
      `  RALPHCTL_HOME : ${HOME_DIR}${EXPLICIT_HOME === undefined ? ' (auto, wiped each run)' : ' (explicit, additive)'}`,
      `  target repo   : ${String(summary.repoDir)}  (git-initialised, python3 hello.py)`,
      `  project       : ${summary.projectName}`,
      '',
      `  Sprints (token ${TOKEN}):`,
      ...summary.sprints.map((s) => `    • "${s.name}"  ${s.state}`),
      line,
      '',
    ].join('\n')
  );

  if (process.env.RALPHCTL_MOCK_NO_LAUNCH) {
    process.stdout.write(`Launch it with:\n\n  RALPHCTL_HOME=${HOME_DIR} pnpm dev\n\n`);
    return;
  }

  process.stdout.write('Launching the TUI against the sandbox…\n\n');
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, RALPHCTL_HOME: HOME_DIR },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
};

await main();
