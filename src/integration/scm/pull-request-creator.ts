import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import {
  detectPullRequestPlatform,
  parseUrlFromCliStdout,
  type PullRequestCreator,
  type PullRequestCreatorInput,
  type PullRequestCreatorOutput,
  type PullRequestPlatform,
} from '@src/business/scm/pull-request-creator.ts';

/**
 * Adapter for the `PullRequestCreator` port — dispatches to the local `gh` (GitHub) or `glab`
 * (GitLab) CLI based on the repo's `origin` remote URL. Reads the URL through `GitRunner` (so
 * tests inject a fake) and spawns the platform CLI through `Spawn` (likewise).
 *
 * Mirrors the v1 `PullRequestRunner` shape but adapted to v2's port + functional-runner style:
 *  - port lives in `core/external/`, this module never imports from `business/usecases/`.
 *  - dependencies are passed via a deps record consumed by the factory; no class.
 *  - timeout matches v1 (60s) — `gh` and `glab` block on auth checks and network round-trips.
 */
const CLI_TIMEOUT_MS = 60_000;

export interface PullRequestCreatorDeps {
  readonly gitRunner: GitRunner;
  readonly spawn: Spawn;
}

const getOriginRemoteUrl = async (
  gitRunner: GitRunner,
  cwd: PullRequestCreatorInput['cwd']
): Promise<Result<string, StorageError>> => {
  const result = await gitRunner.run(cwd, ['remote', 'get-url', 'origin']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git remote get-url origin failed: ${(result.value.stderr || result.value.stdout).trim() || 'unknown error'}`,
      })
    );
  }
  const url = result.value.stdout.trim();
  if (url.length === 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `no 'origin' remote configured at ${String(cwd)}`,
      })
    );
  }
  return Result.ok(url);
};

const buildGhArgs = (input: PullRequestCreatorInput): readonly string[] => {
  const args = [
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
  if (input.draft) args.push('--draft');
  return args;
};

const buildGlabArgs = (input: PullRequestCreatorInput): readonly string[] => {
  const args = [
    'mr',
    'create',
    '--target-branch',
    input.base,
    '--source-branch',
    input.branch,
    '--title',
    input.title,
    '--description',
    input.body,
  ];
  if (input.draft) args.push('--draft');
  return args;
};

const runPlatformCli = async (
  spawn: Spawn,
  platform: PullRequestPlatform,
  input: PullRequestCreatorInput
): Promise<Result<PullRequestCreatorOutput, StorageError>> => {
  const command = platform === 'github' ? 'gh' : 'glab';
  const args = platform === 'github' ? buildGhArgs(input) : buildGlabArgs(input);
  const noun = platform === 'github' ? 'gh pr create' : 'glab mr create';

  const result = await runCli(spawn, command, args, { cwd: String(input.cwd), timeoutMs: CLI_TIMEOUT_MS });
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    const stderr = result.value.stderr.trim();
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${noun} failed: ${stderr || 'unknown error'}`,
      })
    );
  }
  const url = parseUrlFromCliStdout(result.value.stdout);
  if (url === null) {
    return Result.error(new StorageError({ subCode: 'io', message: `${noun} succeeded but emitted no URL` }));
  }
  return Result.ok({ url, platform });
};

export const createPullRequestCreator =
  (deps: PullRequestCreatorDeps): PullRequestCreator =>
  async (input) => {
    const remote = await getOriginRemoteUrl(deps.gitRunner, input.cwd);
    if (!remote.ok) return Result.error(remote.error);

    const platform = detectPullRequestPlatform(remote.value);
    if (platform === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `Unknown git host '${remote.value}' — install gh or glab and configure a github/gitlab remote`,
        })
      );
    }
    return runPlatformCli(deps.spawn, platform, input);
  };
