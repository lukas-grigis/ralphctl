import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { FakeGitRunner } from '@src/integration/_test-fakes/fake-git-runner.ts';
import { CheckScriptRunner } from './check-script-runner.ts';
import { DefaultExternalAdapter } from './external-adapter.ts';
import { GitOperations } from './git-operations.ts';
import { IssueFetcher } from './issue-fetcher.ts';
import { PullRequestRunner } from './pull-request-runner.ts';

const cwd = AbsolutePath.trustString('/repo');

function buildAdapter(runner: FakeGitRunner, pr?: PullRequestRunner): DefaultExternalAdapter {
  return new DefaultExternalAdapter(
    new GitOperations(runner),
    new CheckScriptRunner(),
    new IssueFetcher(runner),
    pr ?? new PullRequestRunner()
  );
}

describe('DefaultExternalAdapter (composition smoke)', () => {
  it('delegates branch helpers to the pure module', () => {
    const a = buildAdapter(new FakeGitRunner());
    expect(a.generateBranchName('20260429-101010-x')).toBe('ralphctl/20260429-101010-x');
    expect(a.isValidBranchName('-bad')).toBe(false);
    expect(a.isValidBranchName('feature/x')).toBe(true);
  });

  it('delegates pure git reads to GitOperations', () => {
    const runner = new FakeGitRunner()
      .on((args) => args[0] === 'rev-parse' && args[1] === '--abbrev-ref', { stdout: 'main\n', exitCode: 0 })
      .on((args) => args[0] === 'status' && args[1] === '--porcelain', { stdout: '', exitCode: 0 })
      .on((args) => args[0] === 'rev-parse' && args[1] === 'HEAD', { stdout: 'abc1234\n', exitCode: 0 });
    const a = buildAdapter(runner);
    expect(a.getCurrentBranch(cwd)).toBe('main');
    expect(a.hasUncommittedChanges(cwd)).toBe(false);
    expect(a.verifyBranch(cwd, 'main')).toBe(true);
    expect(a.getHeadSha(cwd)).toBe('abc1234');
  });

  it('delegates issue parsing — unknown URL resolves to null', async () => {
    const a = buildAdapter(new FakeGitRunner());
    const r = await a.fetchIssue('https://example.com/no/such');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('formats an issue via IssueFetcher', () => {
    const a = buildAdapter(new FakeGitRunner());
    const out = a.formatIssueContext({
      title: 'Sample',
      body: 'Body',
      state: 'open',
      comments: [],
    });
    expect(out).toContain('**Title:** Sample');
  });

  it('runCheckScript surfaces a real script result (echo passes)', async () => {
    const a = buildAdapter(new FakeGitRunner());
    const r = await a.runCheckScript(AbsolutePath.trustString(process.cwd()), 'echo ok', 'sprint-start');
    expect(r.passed).toBe(true);
    expect(r.output).toContain('ok');
  });

  it('createPullRequest delegates to PullRequestRunner using the resolved remote', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'remote' && a[1] === 'get-url' && a[2] === 'origin', {
      stdout: 'https://github.com/acme/widgets.git\n',
      exitCode: 0,
    });
    const prRunner = new PullRequestRunner(() => ({
      status: 0,
      stdout: 'https://github.com/acme/widgets/pull/9\n',
      stderr: '',
    }));
    const a = buildAdapter(runner, prRunner);
    const result = await a.createPullRequest({
      cwd,
      branch: 'ralphctl/x',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toBe('https://github.com/acme/widgets/pull/9');
  });

  it('createPullRequest fails when the repo has no `origin` remote', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'remote' && a[1] === 'get-url', {
      stderr: 'fatal: No such remote',
      exitCode: 128,
    });
    const a = buildAdapter(runner);
    const result = await a.createPullRequest({
      cwd,
      branch: 'b',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no 'origin' remote");
  });

  it('createPullRequest surfaces PullRequestRunner errors verbatim', async () => {
    const runner = new FakeGitRunner().on((a) => a[0] === 'remote', {
      stdout: 'https://github.com/x/y.git\n',
      exitCode: 0,
    });
    const prRunner = new PullRequestRunner(() => ({
      status: 1,
      stdout: '',
      stderr: 'gh: not authenticated',
    }));
    const a = buildAdapter(runner, prRunner);
    const result = await a.createPullRequest({
      cwd,
      branch: 'b',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not authenticated');
  });
});
