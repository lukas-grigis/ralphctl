import { describe, expect, it } from 'vitest';

import { FakeGitRunner } from '@src/integration/_test-fakes/fake-git-runner.ts';
import { IssueFetcher, parseIssueUrl } from './issue-fetcher.ts';

describe('parseIssueUrl', () => {
  it('parses a github.com issue URL', () => {
    const r = parseIssueUrl('https://github.com/acme/widget/issues/42');
    expect(r).toStrictEqual({
      host: 'github',
      hostname: 'github.com',
      owner: 'acme',
      repo: 'widget',
      number: 42,
    });
  });

  it('parses a self-hosted gitlab issue URL', () => {
    const r = parseIssueUrl('https://gitlab.example.com/group/project/-/issues/7');
    expect(r).toStrictEqual({
      host: 'gitlab',
      hostname: 'gitlab.example.com',
      owner: 'group',
      repo: 'project',
      number: 7,
    });
  });

  it('parses a gitlab nested-group URL', () => {
    const r = parseIssueUrl('https://gitlab.com/group/sub/proj/-/issues/12');
    expect(r).toStrictEqual({
      host: 'gitlab',
      hostname: 'gitlab.com',
      owner: 'group/sub',
      repo: 'proj',
      number: 12,
    });
  });

  it('returns null for malformed URLs', () => {
    expect(parseIssueUrl('not-a-url')).toBeNull();
  });

  it('returns null for non-issue github paths', () => {
    expect(parseIssueUrl('https://github.com/acme/widget')).toBeNull();
    expect(parseIssueUrl('https://github.com/acme/widget/pull/1')).toBeNull();
  });

  it('returns null for non-numeric issue ids', () => {
    expect(parseIssueUrl('https://github.com/acme/widget/issues/notanumber')).toBeNull();
  });

  it('rejects non-https/http schemes', () => {
    expect(parseIssueUrl('ftp://github.com/acme/widget/issues/1')).toBeNull();
  });
});

describe('IssueFetcher.fetch', () => {
  it('returns Result.ok(null) for unrecognised URLs without spawning', async () => {
    const fetcher = new IssueFetcher(new FakeGitRunner());
    const r = await fetcher.fetch('https://example.com/no/such/thing');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('returns Result.ok(null) for malformed URLs', async () => {
    const fetcher = new IssueFetcher(new FakeGitRunner());
    const r = await fetcher.fetch('not a url');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });
});

describe('IssueFetcher.format', () => {
  const fetcher = new IssueFetcher(new FakeGitRunner());

  it('renders title, body, and comments as markdown', () => {
    const out = fetcher.format({
      title: 'Crash on save',
      body: 'Steps to reproduce…',
      state: 'open',
      comments: [
        { author: 'alice', body: 'I see this too' },
        { author: 'bob', body: 'On 1.2.3 only' },
      ],
    });
    expect(out).toContain('## Source Issue Data');
    expect(out).toContain('**Title:** Crash on save');
    expect(out).toContain('**State:** open');
    expect(out).toContain('Steps to reproduce');
    expect(out).toContain('**Comments (2):**');
    expect(out).toContain('**@alice**');
    expect(out).toContain('**@bob**');
    expect(out).toContain('I see this too');
  });

  it('omits the body block when body is empty', () => {
    const out = fetcher.format({
      title: 't',
      body: '',
      state: 'closed',
      comments: [],
    });
    expect(out).not.toContain('**Body:**');
  });

  it('omits the comments block when there are none', () => {
    const out = fetcher.format({
      title: 't',
      body: 'b',
      state: 'open',
      comments: [],
    });
    expect(out).not.toContain('**Comments');
  });

  it('omits state when empty', () => {
    const out = fetcher.format({
      title: 't',
      body: '',
      state: '',
      comments: [],
    });
    expect(out).not.toContain('**State:**');
  });
});
