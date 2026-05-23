import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '@src/business/observability/logger.ts';
import { createIssueFetcher, parseGitRemoteUrl, parseIssueUrl } from '@src/integration/scm/issue-fetcher.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

const createRecordingLogger = (): {
  readonly logger: Logger;
  readonly warns: string[];
} => {
  const warns: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message) => {
      warns.push(message);
    },
    error: vi.fn(),
    named: () => logger,
  };
  return { logger, warns };
};

const scriptedSpawn = (
  responses: ReadonlyArray<{
    readonly command: string;
    readonly args: readonly string[];
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode: number;
  }>
): Spawn => {
  let i = 0;
  return (command, args) => {
    const next = responses[i++];
    if (!next) throw new Error(`unscripted spawn ${command} ${args.join(' ')}`);
    if (next.command !== command || JSON.stringify(next.args) !== JSON.stringify([...args])) {
      throw new Error(`expected ${next.command} ${next.args.join(' ')} got ${command} ${args.join(' ')}`);
    }
    const child = makeChild(next.stdout, next.stderr ?? '', next.exitCode);
    return child;
  };
};

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

describe('parseIssueUrl', () => {
  it('parses GitHub issue URLs', () => {
    expect(parseIssueUrl('https://github.com/x/y/issues/42')).toEqual({
      host: 'github',
      owner: 'x',
      repo: 'y',
      number: 42,
    });
  });

  it('parses GitLab issue URLs (group/project/-/issues/N)', () => {
    expect(parseIssueUrl('https://gitlab.com/foo/bar/-/issues/7')).toEqual({
      host: 'gitlab',
      owner: 'foo',
      repo: 'bar',
      number: 7,
    });
  });

  it('returns null for unrecognised URLs', () => {
    expect(parseIssueUrl('https://example.com/foo')).toBeNull();
    expect(parseIssueUrl('not a url')).toBeNull();
  });
});

describe('parseGitRemoteUrl', () => {
  it('parses HTTPS GitHub remote URLs', () => {
    expect(parseGitRemoteUrl('https://github.com/acme/repo.git')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'repo',
    });
  });

  it('parses HTTPS GitHub remote URLs without .git suffix', () => {
    expect(parseGitRemoteUrl('https://github.com/acme/repo')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'repo',
    });
  });

  it('parses SSH shorthand for GitHub', () => {
    expect(parseGitRemoteUrl('git@github.com:acme/repo.git')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'repo',
    });
  });

  it('parses SSH URI for GitLab', () => {
    expect(parseGitRemoteUrl('ssh://git@gitlab.com/group/sub/repo.git')).toEqual({
      provider: 'gitlab',
      owner: 'group/sub',
      repo: 'repo',
    });
  });

  it('parses HTTPS GitLab with nested groups', () => {
    expect(parseGitRemoteUrl('https://gitlab.com/parent/child/repo.git')).toEqual({
      provider: 'gitlab',
      owner: 'parent/child',
      repo: 'repo',
    });
  });

  it('treats unknown hosts as gitlab (self-hosted)', () => {
    expect(parseGitRemoteUrl('git@gitlab.example.internal:team/repo.git')).toEqual({
      provider: 'gitlab',
      owner: 'team',
      repo: 'repo',
    });
  });

  it('returns null for empty / malformed input', () => {
    expect(parseGitRemoteUrl('')).toBeNull();
    expect(parseGitRemoteUrl('   ')).toBeNull();
    expect(parseGitRemoteUrl('not a url')).toBeNull();
    expect(parseGitRemoteUrl('https://example.com/')).toBeNull();
  });
});

describe('createIssueFetcher', () => {
  it('GitHub success — parses gh output and maps fields', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'view', '42', '--repo', 'x/y', '--json', 'title,body,state,url,comments'],
        stdout: JSON.stringify({
          title: 'Hello',
          body: 'World',
          state: 'OPEN',
          url: 'https://github.com/x/y/issues/42',
          comments: [{ author: { login: 'alice' }, body: 'first' }],
        }),
        exitCode: 0,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://github.com/x/y/issues/42');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.title).toBe('Hello');
    expect(out.value.body).toBe('World');
    expect(out.value.state).toBe('open');
    expect(out.value.comments).toEqual([{ author: 'alice', body: 'first' }]);
  });

  it('GitHub 404 — returns Result.ok(null)', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'gh',
        args: ['issue', 'view', '99', '--repo', 'x/y', '--json', 'title,body,state,url,comments'],
        stdout: '',
        stderr: 'GraphQL: Could not resolve issue with that number (issue #99)',
        exitCode: 1,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://github.com/x/y/issues/99');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBeNull();
  });

  it('GitLab success — maps description → body', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({
          title: 'GLab issue',
          description: 'desc body',
          state: 'closed',
          web_url: 'https://gitlab.com/foo/bar/-/issues/5',
        }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: '[]',
        exitCode: 0,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.title).toBe('GLab issue');
    expect(out.value.body).toBe('desc body');
    expect(out.value.state).toBe('closed');
    expect(out.value.comments).toEqual([]);
  });

  it('GitLab notes — filters system notes, maps username + body', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({
          title: 'T',
          description: 'D',
          state: 'opened',
          web_url: 'https://gitlab.com/foo/bar/-/issues/5',
        }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify([
          { body: 'first reply', author: { username: 'alice' }, system: false, created_at: '2026-01-01T00:00:00Z' },
          {
            body: 'assigned to bob',
            author: { username: 'gitlab-bot' },
            system: true,
            created_at: '2026-01-02T00:00:00Z',
          },
          { body: 'second reply', author: { username: 'bob' }, system: false, created_at: '2026-01-03T00:00:00Z' },
        ]),
        exitCode: 0,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.comments).toEqual([
      { author: 'alice', body: 'first reply' },
      { author: 'bob', body: 'second reply' },
    ]);
  });

  it('GitLab notes — all-system fixture yields comments: []', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({ title: 'T', description: 'D', state: 'opened' }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify([
          { body: 'closed', author: { username: 'bot' }, system: true, created_at: '2026-01-01T00:00:00Z' },
          { body: 'reopened', author: { username: 'bot' }, system: true, created_at: '2026-01-02T00:00:00Z' },
        ]),
        exitCode: 0,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.comments).toEqual([]);
  });

  it('GitLab notes — caps at last 20 oldest-first, even when input is newest-first', async () => {
    const total = 25;
    // Emit newest-first so we exercise the defensive sort.
    const raw = Array.from({ length: total }, (_, i) => {
      const idx = total - 1 - i;
      return {
        body: `note ${String(idx)}`,
        author: { username: `u${String(idx)}` },
        system: false,
        created_at: `2026-01-${String(idx + 1).padStart(2, '0')}T00:00:00Z`,
      };
    });
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({ title: 'T', description: 'D', state: 'opened' }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify(raw),
        exitCode: 0,
      },
    ]);
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.comments).toHaveLength(20);
    // Oldest of the kept window: index 5 (0..4 dropped); newest: index 24.
    expect(out.value.comments[0]).toEqual({ author: 'u5', body: 'note 5' });
    expect(out.value.comments[19]).toEqual({ author: 'u24', body: 'note 24' });
  });

  it('GitLab note-list non-zero exit — issue still returned, comments: [], one warn, no throw', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({
          title: 'T',
          description: 'D',
          state: 'opened',
          web_url: 'https://gitlab.com/foo/bar/-/issues/5',
        }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: '',
        stderr: 'permission denied',
        exitCode: 1,
      },
    ]);
    const { logger, warns } = createRecordingLogger();
    const fetcher = createIssueFetcher({ spawn, logger });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.title).toBe('T');
    expect(out.value.body).toBe('D');
    expect(out.value.state).toBe('open');
    expect(out.value.url).toBe('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.value.comments).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('glab issue note list failed');
    expect(warns[0]).toContain('permission denied');
  });

  it('GitLab note-list JSON parse error — issue still returned, comments: [], one warn', async () => {
    const spawn = scriptedSpawn([
      {
        command: 'glab',
        args: ['issue', 'view', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: JSON.stringify({
          title: 'T',
          description: 'D',
          state: 'opened',
          web_url: 'https://gitlab.com/foo/bar/-/issues/5',
        }),
        exitCode: 0,
      },
      {
        command: 'glab',
        args: ['issue', 'note', 'list', '5', '--repo', 'foo/bar', '--output', 'json'],
        stdout: 'not json',
        exitCode: 0,
      },
    ]);
    const { logger, warns } = createRecordingLogger();
    const fetcher = createIssueFetcher({ spawn, logger });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.title).toBe('T');
    expect(out.value.body).toBe('D');
    expect(out.value.comments).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('failed to parse');
  });

  it('GitLab note-list spawn error — issue still returned, comments: [], one warn', async () => {
    let call = 0;
    const spawn: Spawn = (command, args) => {
      call += 1;
      if (call === 1) {
        // First spawn is `glab issue view` — succeed normally.
        return makeChild(
          JSON.stringify({
            title: 'T',
            description: 'D',
            state: 'opened',
            web_url: 'https://gitlab.com/foo/bar/-/issues/5',
          }),
          '',
          0
        );
      }
      // Second spawn (`glab issue note list ...`) blows up before producing a child.
      throw new Error(`spawn EACCES ${command} ${args.join(' ')}`);
    };
    const { logger, warns } = createRecordingLogger();
    const fetcher = createIssueFetcher({ spawn, logger });
    const out = await fetcher('https://gitlab.com/foo/bar/-/issues/5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.value === null) return;
    expect(out.value.title).toBe('T');
    expect(out.value.body).toBe('D');
    expect(out.value.comments).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('glab issue note list failed');
  });

  it('unrecognised host → Result.ok(null) without spawning', async () => {
    const spawn = scriptedSpawn([]); // no responses scripted; would throw if invoked
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://example.com/foo');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBeNull();
  });

  it('spawn failure → StorageError', async () => {
    const spawn: Spawn = () => {
      throw new Error('command not found');
    };
    const fetcher = createIssueFetcher({ spawn });
    const out = await fetcher('https://github.com/x/y/issues/1');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.subCode).toBe('io');
      expect(out.error.message).toContain('gh not installed');
    }
  });
});
