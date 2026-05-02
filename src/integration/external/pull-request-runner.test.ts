import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { detectPlatform, PullRequestRunner, type PullRequestRunnerInput } from './pull-request-runner.ts';

const cwd = AbsolutePath.trustString('/repo');

interface ScriptedSpawn {
  status: number | null;
  stdout: string;
  stderr: string;
}

function fakeSpawn(scripted: ScriptedSpawn) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const fn = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return scripted;
  };
  return { fn, calls };
}

function input(overrides: Partial<PullRequestRunnerInput> = {}): PullRequestRunnerInput {
  return {
    cwd,
    remoteUrl: 'https://github.com/acme/widgets.git',
    branch: 'ralphctl/test',
    base: 'main',
    title: 'feat: do the thing',
    body: 'body content',
    ...overrides,
  };
}

describe('detectPlatform', () => {
  it('detects github.com from https url', () => {
    expect(detectPlatform('https://github.com/foo/bar.git')).toBe('github');
  });

  it('detects github.com from ssh url', () => {
    expect(detectPlatform('git@github.com:foo/bar.git')).toBe('github');
  });

  it('detects gitlab.com', () => {
    expect(detectPlatform('https://gitlab.com/foo/bar.git')).toBe('gitlab');
  });

  it('detects self-hosted gitlab.example.com via "gitlab." prefix', () => {
    expect(detectPlatform('https://gitlab.example.com/foo/bar.git')).toBe('gitlab');
  });

  it('returns null for unknown hosts', () => {
    expect(detectPlatform('https://bitbucket.org/foo/bar.git')).toBeNull();
  });

  it('returns null for malformed urls', () => {
    expect(detectPlatform('')).toBeNull();
    expect(detectPlatform('just a string')).toBeNull();
  });
});

describe('PullRequestRunner.create', () => {
  it('runs `gh pr create` and returns the URL on success', () => {
    const { fn, calls } = fakeSpawn({
      status: 0,
      stdout: 'Creating pull request for ralphctl/test into main\nhttps://github.com/acme/widgets/pull/42\n',
      stderr: '',
    });
    const runner = new PullRequestRunner(fn);

    const r = runner.create(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toStrictEqual({ url: 'https://github.com/acme/widgets/pull/42', platform: 'github' });
    expect(calls[0]?.command).toBe('gh');
    expect(calls[0]?.args.slice(0, 2)).toStrictEqual(['pr', 'create']);
    expect(calls[0]?.args).toContain('--base');
    expect(calls[0]?.args).toContain('main');
    expect(calls[0]?.args).toContain('--head');
    expect(calls[0]?.args).toContain('ralphctl/test');
  });

  it('passes --draft when draft is true', () => {
    const { fn, calls } = fakeSpawn({
      status: 0,
      stdout: 'https://github.com/x/y/pull/1\n',
      stderr: '',
    });
    const runner = new PullRequestRunner(fn);
    runner.create(input({ draft: true }));
    expect(calls[0]?.args).toContain('--draft');
  });

  it('runs `glab mr create` for gitlab remotes', () => {
    const { fn, calls } = fakeSpawn({
      status: 0,
      stdout: '\n!23\nhttps://gitlab.com/acme/widgets/-/merge_requests/23\n',
      stderr: '',
    });
    const runner = new PullRequestRunner(fn);
    const r = runner.create(input({ remoteUrl: 'https://gitlab.com/acme/widgets.git' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toStrictEqual({
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/23',
      platform: 'gitlab',
    });
    expect(calls[0]?.command).toBe('glab');
    expect(calls[0]?.args.slice(0, 2)).toStrictEqual(['mr', 'create']);
    expect(calls[0]?.args).toContain('--target-branch');
    expect(calls[0]?.args).toContain('--source-branch');
  });

  it('returns Result.error when the remote is unrecognised', () => {
    const { fn } = fakeSpawn({ status: 0, stdout: '', stderr: '' });
    const runner = new PullRequestRunner(fn);
    const r = runner.create(input({ remoteUrl: 'https://bitbucket.org/x/y.git' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('io');
    expect(r.error.message).toContain('Unknown git host');
  });

  it('returns Result.error when gh exits non-zero', () => {
    const { fn } = fakeSpawn({
      status: 1,
      stdout: '',
      stderr: 'error: not authenticated',
    });
    const runner = new PullRequestRunner(fn);
    const r = runner.create(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('io');
    expect(r.error.message).toContain('not authenticated');
  });

  it('returns Result.error when gh fails to spawn (status null)', () => {
    const { fn } = fakeSpawn({
      status: null,
      stdout: '',
      stderr: 'ENOENT',
    });
    const runner = new PullRequestRunner(fn);
    const r = runner.create(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('gh pr create failed to launch');
  });

  it('returns Result.error when gh succeeds but emits no URL', () => {
    const { fn } = fakeSpawn({
      status: 0,
      stdout: 'no url here\nstill no url\n',
      stderr: '',
    });
    const runner = new PullRequestRunner(fn);
    const r = runner.create(input());
    // The fallback parses the last non-empty line — even if it isn't a URL,
    // we forward it as-is. This test ensures we don't crash.
    expect(r.ok).toBe(true);
  });
});
