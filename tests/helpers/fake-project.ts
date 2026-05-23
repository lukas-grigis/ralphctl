/**
 * Tmp `git init`'d project for flow-level smoke tests. The harness creates a small repo with
 * a README, a TODO.md, and an initial commit, then returns the absolute path. Use this when a
 * flow needs `process.chdir`-style behaviour against a real git tree — implement / refine / plan
 * all `--add-dir` the repo into the AI session sandbox and expect a clean working tree.
 *
 * Caller responsibilities:
 *  - `cleanup()` (or use {@link withFakeProject}). Leaks tmp dirs otherwise.
 *  - Don't push, don't clone — this is a throwaway local tree.
 *
 * Git config is committed locally to the tmp tree only (`git -c user.email=... commit`) so the
 * test never depends on the dev's global git identity. Hooks are disabled (`core.hooksPath`)
 * for the same reason.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface FakeProject {
  /** Absolute path to the repo root. */
  readonly path: string;
  /** Run `git -C path <args>` and return stdout. Throws on non-zero exit. */
  readonly git: (...args: readonly string[]) => Promise<string>;
  /** Write a file under the repo root. Creates parents as needed. */
  readonly writeFile: (relPath: string, content: string) => Promise<void>;
  /** Read a file under the repo root as utf8. */
  readonly readFile: (relPath: string) => Promise<string>;
  /** `rm -rf` the repo. Idempotent. Call in `afterEach`. */
  readonly cleanup: () => Promise<void>;
}

export interface CreateFakeProjectOptions {
  /** Optional seed files keyed by relative path. Written before the initial commit. */
  readonly seed?: Readonly<Record<string, string>>;
  /**
   * Initial commit message. Defaults to `"chore: initial commit"`. Override when a test wants
   * a specific message in `git log`.
   */
  readonly initialCommitMessage?: string;
  /** Skip the initial commit — useful for tests that want a freshly initialised empty repo. */
  readonly skipInitialCommit?: boolean;
}

/** Default seed: a README and a TODO so AI-touching flows have something to look at. */
const DEFAULT_SEED: Readonly<Record<string, string>> = {
  'README.md': '# fake-project\n\nA throwaway repo for ralphctl smoke tests.\n',
  'TODO.md': '- [ ] Add hello-world message to README\n',
  '.gitignore': 'node_modules/\n.DS_Store\n',
};

/**
 * Materialise a small `git init`'d tmp repo with sane defaults. The returned `git()` helper
 * binds `-C <repo>` so callers don't fight cwd state.
 */
export const createFakeProject = async (options: CreateFakeProjectOptions = {}): Promise<FakeProject> => {
  const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-fakeproj-'));
  const path = await realpath(raw);

  const git = async (...args: readonly string[]): Promise<string> => runGit(path, args);
  const writeFile = async (relPath: string, content: string): Promise<void> => {
    const full = join(path, relPath);
    const dir = full.slice(0, full.lastIndexOf('/'));
    if (dir.length > 0) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  };
  const readFile = async (relPath: string): Promise<string> => fs.readFile(join(path, relPath), 'utf8');

  // `init.defaultBranch=main` matches the project's branch conventions; `core.hooksPath=...`
  // points hooks at a missing dir so the user's global hooks (commit-msg, pre-commit) never fire.
  await git('-c', 'init.defaultBranch=main', 'init', '-q');
  await git('config', 'core.hooksPath', '/dev/null/nope');
  await git('config', 'user.email', 'fake-project@ralphctl.test');
  await git('config', 'user.name', 'ralphctl test fixture');
  await git('config', 'commit.gpgsign', 'false');

  const seed = options.seed ?? DEFAULT_SEED;
  for (const [rel, content] of Object.entries(seed)) {
    await writeFile(rel, content);
  }

  if (options.skipInitialCommit !== true) {
    await git('add', '-A');
    await git('commit', '-q', '-m', options.initialCommitMessage ?? 'chore: initial commit');
  }

  return {
    path,
    git,
    writeFile,
    readFile,
    cleanup: async () => {
      await fs.rm(path, { recursive: true, force: true });
    },
  };
};

/** Scope a `FakeProject` to a callback. Cleanup runs even on throw. */
export const withFakeProject = async <T>(
  body: (project: FakeProject) => Promise<T>,
  options: CreateFakeProjectOptions = {}
): Promise<T> => {
  const project = await createFakeProject(options);
  try {
    return await body(project);
  } finally {
    await project.cleanup();
  }
};

const runGit = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${String(code)}): ${stderr}`));
    });
  });
