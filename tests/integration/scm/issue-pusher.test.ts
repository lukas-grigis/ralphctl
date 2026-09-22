import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import { createIssuePusher } from '@src/integration/scm/issue-pusher.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

interface ScriptedResponse {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

interface SpawnCapture {
  readonly stdinWrites: string[];
}

const scriptedSpawn = (responses: readonly ScriptedResponse[]): { spawn: Spawn; capture: SpawnCapture } => {
  let i = 0;
  const stdinWrites: string[] = [];
  const spawn: Spawn = (command, args) => {
    const next = responses[i++];
    if (!next) throw new Error(`unscripted spawn ${command} ${args.join(' ')}`);
    if (next.command !== command || JSON.stringify(next.args) !== JSON.stringify([...args])) {
      throw new Error(`expected ${next.command} ${next.args.join(' ')} got ${command} ${args.join(' ')}`);
    }
    return makeChild(next.stdout, next.stderr ?? '', next.exitCode, stdinWrites);
  };
  return { spawn, capture: { stdinWrites } };
};

const makeChild = (
  stdout: string,
  stderr: string,
  exitCode: number,
  stdinWrites: string[]
): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdoutStream = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderrStream = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  Object.assign(child, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: {
      end(payload?: string): void {
        if (payload !== undefined) stdinWrites.push(payload);
      },
    },
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

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};

const CWD = absPath('/repo');

const unusedGitRunner: GitRunner = {
  async run() {
    throw new Error('gitRunner should not be called');
  },
};

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

describe('createIssuePusher — comment', () => {
  it('GitHub: dispatches to `gh issue comment` with body on stdin', async () => {
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'comment', '42', '--repo', 'x/y', '--body-file', '-'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.comment('https://github.com/x/y/issues/42', { body: 'new body' });
    expect(r.ok).toBe(true);
    expect(capture.stdinWrites).toEqual(['new body']);
  });

  it('GitLab: dispatches to `glab issue comment` with --message flag', async () => {
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'comment', '7', '--repo', 'gitlab.com/foo/bar', '--message', 'new body'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.comment('https://gitlab.com/foo/bar/-/issues/7', { body: 'new body' });
    expect(r.ok).toBe(true);
    // glab takes the body as a flag value, not on stdin.
    expect(capture.stdinWrites).toEqual([]);
  });

  it('self-hosted GitLab: prefixes the URL host onto glab --repo', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'comment', '55', '--repo', 'gitlab.example.internal/team/project', '--message', 'done'],
        stdout: '',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.comment('https://gitlab.example.internal/team/project/-/work_items/55', { body: 'done' });
    expect(r.ok).toBe(true);
  });

  it('rejects unsupported issue URLs with a parse error', async () => {
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.comment('https://example.com/not-an-issue', { body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/unsupported issue URL/);
  });

  it('surfaces a CLI non-zero exit as a StorageError', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'comment', '42', '--repo', 'x/y', '--body-file', '-'],
        stdout: '',
        stderr: 'gh: not authenticated',
        exitCode: 1,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.comment('https://github.com/x/y/issues/42', { body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/gh issue comment failed.*not authenticated/);
  });
});

describe('createIssuePusher — resolveOrigin', () => {
  it('parses a GitHub HTTPS origin into provider, hostname, owner, repo', async () => {
    const { gitRunner, calls } = gitRunnerWith(okRemote('https://github.com/acme/repo.git'));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ provider: 'github', hostname: 'github.com', owner: 'acme', repo: 'repo' });
    expect(calls).toEqual([['remote', 'get-url', 'origin']]);
  });

  it('parses a self-hosted GitLab SSH origin including the hostname', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('git@gitlab.example.internal:team/project.git'));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      provider: 'gitlab',
      hostname: 'gitlab.example.internal',
      owner: 'team',
      repo: 'project',
    });
  });

  it('returns null when origin is missing', async () => {
    const { gitRunner } = gitRunnerWith(Result.ok({ stdout: '', stderr: 'no such remote', exitCode: 2 }));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('returns null when origin is empty', async () => {
    const { gitRunner } = gitRunnerWith(Result.ok({ stdout: '  \n', stderr: '', exitCode: 0 }));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('returns null when origin is not GitHub or GitLab', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://bitbucket.org/x/y.git'));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('surfaces a git transport failure as StorageError', async () => {
    const transportError = new StorageError({ subCode: 'io', message: 'git not installed' });
    const { gitRunner } = gitRunnerWith(Result.error(transportError));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.resolveOrigin(CWD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(transportError);
  });
});

describe('createIssuePusher — create', () => {
  it('GitHub: dispatches to `gh issue create --repo owner/repo --title` with body on stdin', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://github.com/x/y.git'));
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'create', '--repo', 'x/y', '--title', 'Add the thing', '--body-file', '-'],
        stdout: 'https://github.com/x/y/issues/42\n',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.create({ cwd: CWD, title: 'Add the thing', body: 'the body' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://github.com/x/y/issues/42' });
    expect(capture.stdinWrites).toEqual(['the body']);
  });

  it('GitLab: dispatches to `glab issue create --repo HOST/OWNER/REPO --title --description`', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('https://gitlab.com/foo/bar.git'));
    const { spawn, capture } = scriptedSpawn([
      {
        command: 'glab',
        args: [
          'issue',
          'create',
          '--repo',
          'gitlab.com/foo/bar',
          '--title',
          'Add the thing',
          '--description',
          'the body',
        ],
        stdout: 'https://gitlab.com/foo/bar/-/issues/7\n',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.create({ cwd: CWD, title: 'Add the thing', body: 'the body' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ url: 'https://gitlab.com/foo/bar/-/issues/7' });
    expect(capture.stdinWrites).toEqual([]);
  });

  it('self-hosted GitLab: prefixes the origin host onto glab --repo', async () => {
    const { gitRunner } = gitRunnerWith(okRemote('git@gitlab.example.internal:team/project.git'));
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: [
          'issue',
          'create',
          '--repo',
          'gitlab.example.internal/team/project',
          '--title',
          'Work item',
          '--description',
          '',
        ],
        stdout: 'https://gitlab.example.internal/team/project/-/issues/55\n',
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.create({ cwd: CWD, title: 'Work item', body: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toBe('https://gitlab.example.internal/team/project/-/issues/55');
  });

  it('unresolved origin fails create without spawning gh or glab', async () => {
    const { gitRunner } = gitRunnerWith(Result.ok({ stdout: '', stderr: 'no such remote', exitCode: 2 }));
    const { spawn } = scriptedSpawn([]);
    const pusher = createIssuePusher({ spawn, gitRunner });
    const r = await pusher.create({ cwd: CWD, title: 'x', body: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/no GitHub or GitLab origin/);
  });
});

describe('createIssuePusher — listComments', () => {
  it('GitHub: returns every comment body without truncating', async () => {
    const comments = Array.from({ length: 21 }, (_, i) => ({ body: `c${String(i)}` }));
    const { spawn } = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'view', '42', '--repo', 'x/y', '--json', 'title,body,state,url,comments'],
        stdout: JSON.stringify({ comments }),
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.listComments('https://github.com/x/y/issues/42');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(comments.map((c) => c.body));
  });

  it('GitLab: returns every note body, dropping system notes, without truncating', async () => {
    const notes = [
      { body: 'first', system: false, created_at: '2026-01-01T00:00:00Z' },
      { body: 'label change', system: true, created_at: '2026-01-02T00:00:00Z' },
      ...Array.from({ length: 21 }, (_, i) => ({
        body: `n${String(i)}`,
        system: false,
        created_at: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    ];
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: [
          'api',
          '--hostname',
          'gitlab.com',
          '--paginate',
          '--output',
          'json',
          'projects/foo%2Fbar/issues/7/notes?per_page=100&sort=asc&order_by=created_at',
        ],
        stdout: JSON.stringify(notes),
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.listComments('https://gitlab.com/foo/bar/-/issues/7');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(22);
    expect(r.value).toContain('first');
    expect(r.value).not.toContain('label change');
    expect(r.value.at(-1)).toBe('n20');
  });

  it('self-hosted GitLab subgroup: targets the host and URL-encodes the full project path', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: [
          'api',
          '--hostname',
          'gitlab.example.internal',
          '--paginate',
          '--output',
          'json',
          'projects/team%2Fsub%2Fproject/issues/55/notes?per_page=100&sort=asc&order_by=created_at',
        ],
        stdout: JSON.stringify([{ body: 'hello', system: false }]),
        exitCode: 0,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.listComments('https://gitlab.example.internal/team/sub/project/-/work_items/55');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['hello']);
  });

  it('GitLab: a failing notes request surfaces the glab api stderr', async () => {
    const { spawn } = scriptedSpawn([
      {
        command: 'glab',
        args: [
          'api',
          '--hostname',
          'gitlab.com',
          '--paginate',
          '--output',
          'json',
          'projects/foo%2Fbar/issues/7/notes?per_page=100&sort=asc&order_by=created_at',
        ],
        stdout: '',
        stderr: '404 Not Found',
        exitCode: 1,
      },
    ]);
    const pusher = createIssuePusher({ spawn, gitRunner: unusedGitRunner });
    const r = await pusher.listComments('https://gitlab.com/foo/bar/-/issues/7');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('glab api issue notes failed: 404 Not Found');
  });
});
