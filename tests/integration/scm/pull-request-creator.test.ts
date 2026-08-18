/**
 * Adapter-level tests for `createPullRequestCreator`.
 *
 * The pure helpers (`parseRemoteHostname` / `detectPullRequestPlatform` / `parseUrlFromCliStdout`)
 * are covered in `tests/unit/business/scm/pull-request-creator.test.ts`; every flow-level test
 * injects a stub `PullRequestCreator` port. What is only reachable here is the adapter itself:
 * the exact `gh pr create` / `glab mr create` argv, the `cwd` the child is spawned in, and the
 * four `StorageError` paths (no origin, unknown host, non-zero exit, zero exit with no URL).
 * Modelled on `issue-pusher.test.ts` — only the process boundary (`Spawn`) and the `GitRunner`
 * transport are faked; the argv builders and error mapping run for real.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { createPullRequestCreator } from '@src/integration/scm/pull-request-creator.ts';
import type { PullRequestCreatorInput } from '@src/business/scm/pull-request-creator.ts';

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};

const CWD = absPath('/repo');

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

interface ScriptedChild {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Throw synchronously from `spawn` — models a missing binary. */
  readonly throws?: Error;
}

const makeChild = (stdout: string, stderr: string, exitCode: number): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdoutStream = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderrStream = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  Object.assign(child, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: { end(): void {} },
    kill(): boolean {
      return true;
    },
  });
  setImmediate(() => {
    if (stdout) stdoutStream.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) stderrStream.emit('data', Buffer.from(stderr, 'utf8'));
    setImmediate(() => child.emit('close', exitCode));
  });
  return child;
};

const scriptedSpawn = (scripted: ScriptedChild): { spawn: Spawn; calls: SpawnCall[] } => {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    if (scripted.throws) throw scripted.throws;
    return makeChild(scripted.stdout ?? '', scripted.stderr ?? '', scripted.exitCode ?? 0);
  };
  return { spawn, calls };
};

/** `GitRunner` fake that answers `remote get-url origin` and records the argv it was asked for. */
const gitRunnerWith = (
  answer: Result<GitRunResult, StorageError>
): { gitRunner: GitRunner; calls: Array<readonly string[]> } => {
  const calls: Array<readonly string[]> = [];
  const gitRunner: GitRunner = {
    run: async (_cwd, args) => {
      calls.push([...args]);
      return answer;
    },
  };
  return { gitRunner, calls };
};

const okRemote = (url: string): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout: `${url}\n`, stderr: '', exitCode: 0 });

const INPUT: PullRequestCreatorInput = {
  cwd: CWD,
  branch: 'ralphctl/sprint-x',
  base: 'main',
  title: 'Add the thing',
  body: 'Body text\nsecond line',
  draft: false,
};

describe('createPullRequestCreator — argv', () => {
  it('GitHub: builds the exact `gh pr create` argv and runs it inside the repo', async () => {
    const { gitRunner, calls: gitCalls } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn, calls } = scriptedSpawn({ stdout: 'https://github.com/x/y/pull/7\n' });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://github.com/x/y/pull/7', platform: 'github' });
    expect(gitCalls).toEqual([['remote', 'get-url', 'origin']]);
    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'create',
          '--base',
          'main',
          '--head',
          'ralphctl/sprint-x',
          '--title',
          'Add the thing',
          '--body',
          'Body text\nsecond line',
        ],
        cwd: '/repo',
      },
    ]);
  });

  it('GitHub: appends --draft only when the input asks for a draft', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('git@github.com:x/y.git'));
    const { spawn, calls } = scriptedSpawn({ stdout: 'https://github.com/x/y/pull/8\n' });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create({ ...INPUT, draft: true });

    expect(r.ok).toBe(true);
    expect(calls[0]?.args.at(-1)).toBe('--draft');
  });

  it('GitLab: builds the `glab mr create` argv with target/source-branch and --description', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://gitlab.com/foo/bar.git'));
    const { spawn, calls } = scriptedSpawn({ stdout: 'https://gitlab.com/foo/bar/-/merge_requests/3\n' });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create({ ...INPUT, draft: true });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://gitlab.com/foo/bar/-/merge_requests/3', platform: 'gitlab' });
    expect(calls).toEqual([
      {
        command: 'glab',
        args: [
          'mr',
          'create',
          '--target-branch',
          'main',
          '--source-branch',
          'ralphctl/sprint-x',
          '--title',
          'Add the thing',
          '--description',
          'Body text\nsecond line',
          '--draft',
        ],
        cwd: '/repo',
      },
    ]);
  });

  it('self-hosted GitLab host still dispatches to glab', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('git@gitlab.example.internal:team/project.git'));
    const { spawn, calls } = scriptedSpawn({
      stdout: 'https://gitlab.example.internal/team/project/-/merge_requests/1\n',
    });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(true);
    expect(calls[0]?.command).toBe('glab');
  });

  it('picks the URL line out of noisy CLI stdout', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn } = scriptedSpawn({
      stdout:
        'Creating pull request for ralphctl/sprint-x into main\n\nhttps://github.com/x/y/pull/12\nWarning: draft\n',
    });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toBe('https://github.com/x/y/pull/12');
  });
});

describe('createPullRequestCreator — failure paths', () => {
  it('surfaces a non-zero CLI exit as a StorageError carrying the stderr text', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn } = scriptedSpawn({ stderr: 'pull request already exists for branch\n', exitCode: 1 });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(StorageError);
      expect(r.error.message).toBe('gh pr create failed: pull request already exists for branch');
    }
  });

  it('names the platform noun in the failure message for gitlab too', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://gitlab.com/foo/bar.git'));
    const { spawn } = scriptedSpawn({ stderr: '', exitCode: 2 });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('glab mr create failed: unknown error');
  });

  it('rejects a zero exit that emitted no URL', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn } = scriptedSpawn({ stdout: '   \n\n', exitCode: 0 });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('gh pr create succeeded but emitted no URL');
  });

  it('tells the operator to install gh or glab when the host is neither', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://bitbucket.org/x/y.git'));
    const { spawn, calls } = scriptedSpawn({});

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.message).toMatch(/Unknown git host 'https:\/\/bitbucket\.org\/x\/y\.git' — install gh or glab/);
    // No CLI is spawned once the host is unrecognised.
    expect(calls).toEqual([]);
  });

  it('fails when `git remote get-url origin` exits non-zero', async () => {
    const { gitRunner } = gitRunnerWith(Result.ok({ stdout: '', stderr: 'no such remote', exitCode: 2 }));
    const { spawn, calls } = scriptedSpawn({});

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('git remote get-url origin failed: no such remote');
    expect(calls).toEqual([]);
  });

  it('fails when the origin remote resolves to an empty string', async () => {
    const { gitRunner } = gitRunnerWith(Result.ok({ stdout: '  \n', stderr: '', exitCode: 0 }));
    const { spawn } = scriptedSpawn({});

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("no 'origin' remote configured at /repo");
  });

  it('propagates a GitRunner transport error unchanged', async () => {
    const transportError = new StorageError({ subCode: 'io', message: 'failed to spawn git: ENOENT' });
    const { gitRunner } = gitRunnerWith(Result.error(transportError));
    const { spawn } = scriptedSpawn({});

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(transportError);
  });

  it('maps a missing platform CLI (spawn throws) to a StorageError', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn } = scriptedSpawn({ throws: new Error('spawn gh ENOENT') });

    const create = createPullRequestCreator({ gitRunner, spawn });
    const r = await create(INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('gh not installed or failed to spawn');
  });
});
