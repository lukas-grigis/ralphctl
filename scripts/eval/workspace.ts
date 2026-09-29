import { promises as fs, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';

/**
 * One trial's isolated on-disk world — "each trial should be 'isolated' by starting from a clean
 * environment" (Anthropic, Demystifying evals). A fresh `mkdtemp` per trial:
 *
 *   <root>/            doubles as the production "sprintDir" (mounted as an additional root)
 *   <root>/repo/       the fixture's `repo/` tree, committed as HEAD; the AI session's cwd
 *   <root>/sandbox/    the production "task workspace" (contract.md, rounds/1/<role>/…)
 *
 * The fixture's `oracle/` directory is NEVER copied in here before grading (see `oracle.ts`).
 */
export interface Workspace {
  readonly root: AbsolutePath;
  readonly repo: AbsolutePath;
  readonly sandbox: AbsolutePath;
  readonly cleanup: () => Promise<void>;
}

export interface WorkspaceDeps {
  readonly git: GitRunner;
  /** Parent of the per-trial directory; defaults to the OS temp dir. */
  readonly tmpRoot?: string;
}

const GIT_IDENTITY = ['-c', 'user.name=ralphctl-eval', '-c', 'user.email=eval@ralphctl.invalid'] as const;
const GIT_QUIET = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'] as const;

const storageError = (message: string, path?: string, cause?: unknown): StorageError =>
  new StorageError({ subCode: 'io', message, ...(path !== undefined ? { path } : {}), cause });

const abs = (path: string): Result<AbsolutePath, StorageError> => {
  const parsed = AbsolutePath.parse(path);
  return parsed.ok ? Result.ok(parsed.value) : Result.error(storageError(`not an absolute path: ${path}`, path));
};

/** Run one git command, mapping a non-zero exit to a `StorageError` carrying stderr. */
export const runGit = async (
  git: GitRunner,
  cwd: AbsolutePath,
  args: readonly string[]
): Promise<Result<string, StorageError>> => {
  const ran = await git.run(cwd, [...GIT_QUIET, ...GIT_IDENTITY, ...args]);
  if (!ran.ok) return Result.error(ran.error);
  if (ran.value.exitCode !== 0) {
    return Result.error(
      storageError(`git ${args.join(' ')} exited ${String(ran.value.exitCode)}: ${ran.value.stderr.trim()}`)
    );
  }
  return Result.ok(ran.value.stdout);
};

/** Apply a (possibly empty) patch file UNCOMMITTED. An empty patch is a deliberate no-op. */
export const applyPatchFile = async (
  git: GitRunner,
  repo: AbsolutePath,
  patchPath: string
): Promise<Result<void, StorageError>> => {
  let body: string;
  try {
    body = await fs.readFile(patchPath, 'utf8');
  } catch (cause) {
    return Result.error(storageError(`cannot read patch ${patchPath}: ${messageOf(cause)}`, patchPath, cause));
  }
  if (body.trim().length === 0) return Result.ok(undefined);
  const applied = await runGit(git, repo, ['apply', '--whitespace=nowarn', patchPath]);
  return applied.ok ? Result.ok(undefined) : Result.error(applied.error);
};

/**
 * Materialize a trial workspace: copy `<fixtureDir>/repo`, `git init`, commit it as HEAD, then apply
 * `patchRel` (relative to the fixture directory) as an UNCOMMITTED change — the evaluator's primary
 * input is `git diff HEAD` (`evaluator.ts`), so the reference / defect diff must not be committed.
 */
export const materialize = async (
  deps: WorkspaceDeps,
  fixtureDir: string,
  patchRel?: string
): Promise<Result<Workspace, StorageError>> => {
  let raw: string;
  try {
    raw = await fs.mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'ralphctl-eval-'));
  } catch (cause) {
    return Result.error(storageError(`mkdtemp failed: ${messageOf(cause)}`, deps.tmpRoot, cause));
  }
  const rootPath = realpathSync(raw);
  const cleanup = async (): Promise<void> => {
    await fs.rm(rootPath, { recursive: true, force: true });
  };
  const fail = async (error: StorageError): Promise<Result<Workspace, StorageError>> => {
    await cleanup();
    return Result.error(error);
  };

  const root = abs(rootPath);
  const repo = abs(join(rootPath, 'repo'));
  const sandbox = abs(join(rootPath, 'sandbox'));
  if (!root.ok) return fail(root.error);
  if (!repo.ok) return fail(repo.error);
  if (!sandbox.ok) return fail(sandbox.error);

  try {
    await fs.cp(join(fixtureDir, 'repo'), String(repo.value), { recursive: true });
    await fs.mkdir(String(sandbox.value), { recursive: true });
  } catch (cause) {
    return fail(storageError(`copying the fixture repo failed: ${messageOf(cause)}`, fixtureDir, cause));
  }

  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['commit', '-q', '--allow-empty', '-m', 'base'],
  ]) {
    const step = await runGit(deps.git, repo.value, args);
    if (!step.ok) return fail(step.error);
  }
  if (patchRel !== undefined) {
    const applied = await applyPatchFile(deps.git, repo.value, join(fixtureDir, patchRel));
    if (!applied.ok) return fail(applied.error);
  }
  return Result.ok({ root: root.value, repo: repo.value, sandbox: sandbox.value, cleanup });
};

/** Repo-relative paths with any change vs HEAD — tracked, staged or untracked (`status --porcelain -uall`). */
export const changedPaths = async (
  git: GitRunner,
  repo: AbsolutePath
): Promise<Result<readonly string[], StorageError>> => {
  const status = await runGit(git, repo, ['status', '--porcelain', '-uall']);
  if (!status.ok) return Result.error(status.error);
  const paths = status.value
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
  return Result.ok(paths);
};
