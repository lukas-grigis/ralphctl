// Import the mock after vi.mock is declared
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIssue,
  fetchIssueFromUrl,
  formatIssueContext,
  type IssueData,
  IssueFetchError,
  type ParsedIssueUrl,
  parseIssueUrl,
} from './issue-fetch.ts';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

describe('parseIssueUrl', () => {
  describe('GitHub URLs', () => {
    it('parses a standard GitHub issue URL', () => {
      expect(parseIssueUrl('https://github.com/owner/repo/issues/123')).toEqual({
        host: 'github',
        hostname: 'github.com',
        owner: 'owner',
        repo: 'repo',
        number: 123,
      });
    });

    it('parses a GitHub issue URL with a numeric owner and repo', () => {
      expect(parseIssueUrl('https://github.com/my-org/my-repo/issues/1')).toEqual({
        host: 'github',
        hostname: 'github.com',
        owner: 'my-org',
        repo: 'my-repo',
        number: 1,
      });
    });

    it('parses a GitHub issue URL over http', () => {
      expect(parseIssueUrl('http://github.com/owner/repo/issues/5')).toEqual({
        host: 'github',
        hostname: 'github.com',
        owner: 'owner',
        repo: 'repo',
        number: 5,
      });
    });

    it('returns null for a GitHub pull request URL', () => {
      expect(parseIssueUrl('https://github.com/owner/repo/pulls/1')).toBeNull();
    });

    it('returns null for a GitHub URL without an issue number', () => {
      expect(parseIssueUrl('https://github.com/owner/repo/issues')).toBeNull();
    });

    it('returns null for a GitHub repository URL', () => {
      expect(parseIssueUrl('https://github.com/owner/repo')).toBeNull();
    });

    it('returns null for issue number zero', () => {
      expect(parseIssueUrl('https://github.com/owner/repo/issues/0')).toBeNull();
    });

    it('returns null for a non-integer issue number', () => {
      expect(parseIssueUrl('https://github.com/owner/repo/issues/abc')).toBeNull();
    });
  });

  describe('GitLab URLs', () => {
    it('parses a standard gitlab.com issue URL', () => {
      expect(parseIssueUrl('https://gitlab.com/group/project/-/issues/456')).toEqual({
        host: 'gitlab',
        hostname: 'gitlab.com',
        owner: 'group',
        repo: 'project',
        number: 456,
      });
    });

    it('parses a self-hosted GitLab issue URL', () => {
      expect(parseIssueUrl('https://gitlab.mycompany.com/team/project/-/issues/789')).toEqual({
        host: 'gitlab',
        hostname: 'gitlab.mycompany.com',
        owner: 'team',
        repo: 'project',
        number: 789,
      });
    });

    it('parses a GitLab URL with nested groups — owner joins all path segments before the repo, repo is immediately before /-/', () => {
      // URL: /org/sub/project/-/issues/10
      // segments: ['org', 'sub', 'project', '-', 'issues', '10']
      // dashIdx = 3, repo = segments[2] = 'project', owner = segments.slice(0, 2).join('/') = 'org/sub'
      const result = parseIssueUrl('https://gitlab.com/org/sub/project/-/issues/10');
      expect(result).toEqual({
        host: 'gitlab',
        hostname: 'gitlab.com',
        owner: 'org/sub',
        repo: 'project',
        number: 10,
      });
    });

    it('parses a GitLab issue URL over http', () => {
      expect(parseIssueUrl('http://gitlab.com/group/project/-/issues/7')).toEqual({
        host: 'gitlab',
        hostname: 'gitlab.com',
        owner: 'group',
        repo: 'project',
        number: 7,
      });
    });

    it('returns null for a GitLab URL missing the /-/ separator', () => {
      expect(parseIssueUrl('https://gitlab.com/group/project/issues/456')).toBeNull();
    });

    it('returns null for a GitLab issue number of zero', () => {
      expect(parseIssueUrl('https://gitlab.com/group/project/-/issues/0')).toBeNull();
    });

    it('returns null when path has fewer than two segments before /-/', () => {
      // segments would be: ['group', '-', 'issues', '1'] → dashIdx = 1, not >= 2
      expect(parseIssueUrl('https://gitlab.com/group/-/issues/1')).toBeNull();
    });
  });

  describe('unrecognized URLs', () => {
    it('returns null for a non-issue URL on an unknown host', () => {
      expect(parseIssueUrl('https://example.com/issues/1')).toBeNull();
    });

    it('returns null for a completely invalid URL string', () => {
      expect(parseIssueUrl('not-a-url')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseIssueUrl('')).toBeNull();
    });

    it('returns null for a non-http(s) protocol', () => {
      expect(parseIssueUrl('ftp://github.com/owner/repo/issues/1')).toBeNull();
    });
  });
});

describe('fetchIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GitHub', () => {
    const parsed: ParsedIssueUrl = { host: 'github', hostname: 'github.com', owner: 'owner', repo: 'repo', number: 42 };

    it('returns IssueData on success', () => {
      const ghResponse = {
        title: 'Fix the bug',
        body: 'Description here.',
        comments: [
          { author: { login: 'alice' }, createdAt: '2024-01-01T00:00:00Z', body: 'First comment' },
          { author: { login: 'bob' }, createdAt: '2024-01-02T00:00:00Z', body: 'Second comment' },
        ],
      };
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(ghResponse) }));

      const result = fetchIssue(parsed);

      expect(result).toEqual({
        title: 'Fix the bug',
        body: 'Description here.',
        url: 'https://github.com/owner/repo/issues/42',
        comments: [
          { author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'First comment' },
          { author: 'bob', createdAt: '2024-01-02T00:00:00Z', body: 'Second comment' },
        ],
      });
    });

    it('calls gh with the correct arguments', () => {
      const ghResponse = { title: 'T', body: 'B', comments: [] };
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(ghResponse) }));

      fetchIssue(parsed);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'view', '42', '--repo', 'owner/repo', '--json', 'title,body,comments'],
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('throws IssueFetchError when gh exits with non-zero status', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'Could not find issue' }));

      expect(() => fetchIssue(parsed)).toThrow(IssueFetchError);
      expect(() => {
        mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'Could not find issue' }));
        fetchIssue(parsed);
      }).toThrow('gh issue view failed: Could not find issue');
    });

    it('includes stderr in the error message when available', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 2, stderr: 'authentication failed' }));

      expect(() => fetchIssue(parsed)).toThrow('gh issue view failed: authentication failed');
    });

    it('falls back to "unknown error" when stderr is empty', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: '' }));

      expect(() => fetchIssue(parsed)).toThrow('gh issue view failed: unknown error');
    });

    it('uses empty strings for missing title, body, and comment fields', () => {
      const ghResponse = { comments: [{ author: {}, createdAt: null }] };
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(ghResponse) }));

      const result = fetchIssue(parsed);

      expect(result.title).toBe('');
      expect(result.body).toBe('');
      expect(result.comments[0]).toEqual({ author: 'unknown', createdAt: '', body: '' });
    });

    it('caps comments at 20 (MAX_COMMENTS), keeping the last 20', () => {
      const comments = Array.from({ length: 25 }, (_, i) => ({
        author: { login: `user${String(i)}` },
        createdAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        body: `Comment ${String(i)}`,
      }));
      mockSpawnSync.mockReturnValueOnce(
        makeSpawnResult({ stdout: JSON.stringify({ title: 'T', body: 'B', comments }) })
      );

      const result = fetchIssue(parsed);

      expect(result.comments).toHaveLength(20);
      expect(result.comments.at(0)?.author).toBe('user5');
      expect(result.comments.at(19)?.author).toBe('user24');
    });

    it('handles zero comments', () => {
      mockSpawnSync.mockReturnValueOnce(
        makeSpawnResult({ stdout: JSON.stringify({ title: 'T', body: 'B', comments: [] }) })
      );

      const result = fetchIssue(parsed);

      expect(result.comments).toEqual([]);
    });

    it('handles missing comments field', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', body: 'B' }) }));

      const result = fetchIssue(parsed);

      expect(result.comments).toEqual([]);
    });
  });

  describe('GitLab', () => {
    const parsed: ParsedIssueUrl = {
      host: 'gitlab',
      hostname: 'gitlab.com',
      owner: 'group',
      repo: 'project',
      number: 99,
    };

    it('returns IssueData on success', () => {
      const glabIssue = { title: 'GL issue', description: 'GL description', notes: [] };
      const glabNotes = [{ author: { username: 'charlie' }, created_at: '2024-03-01T10:00:00Z', body: 'Note 1' }];

      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(glabIssue) }))
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(glabNotes) }));

      const result = fetchIssue(parsed);

      expect(result).toEqual({
        title: 'GL issue',
        body: 'GL description',
        url: 'https://gitlab.com/group/project/-/issues/99',
        comments: [{ author: 'charlie', createdAt: '2024-03-01T10:00:00Z', body: 'Note 1' }],
      });
    });

    it('calls glab with the correct arguments for issue and notes', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ stdout: '[]' }));

      fetchIssue(parsed);

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'glab',
        ['issue', 'view', '99', '--repo', 'group/project', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8' })
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'glab',
        ['issue', 'note', 'list', '99', '--repo', 'group/project', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('throws IssueFetchError when glab issue view exits with non-zero status', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'not found' }));

      expect(() => fetchIssue(parsed)).toThrow(IssueFetchError);
      expect(() => {
        mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'not found' }));
        fetchIssue(parsed);
      }).toThrow('glab issue view failed: not found');
    });

    it('falls back to "unknown error" when glab stderr is empty', () => {
      mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: '' }));

      expect(() => fetchIssue(parsed)).toThrow('glab issue view failed: unknown error');
    });

    it('returns empty comments when notes fetch fails', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'notes error' }));

      const result = fetchIssue(parsed);

      expect(result.comments).toEqual([]);
    });

    it('returns empty comments when notes output is empty string', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ status: 0, stdout: '' }));

      const result = fetchIssue(parsed);

      expect(result.comments).toEqual([]);
    });

    it('returns empty comments when notes output is invalid JSON', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ status: 0, stdout: 'not-json' }));

      const result = fetchIssue(parsed);

      expect(result.comments).toEqual([]);
    });

    it('caps notes at 20 (MAX_COMMENTS), keeping the last 20', () => {
      const notes = Array.from({ length: 25 }, (_, i) => ({
        author: { username: `user${String(i)}` },
        created_at: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        body: `Note ${String(i)}`,
      }));

      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(notes) }));

      const result = fetchIssue(parsed);

      expect(result.comments).toHaveLength(20);
      expect(result.comments.at(0)?.author).toBe('user5');
      expect(result.comments.at(19)?.author).toBe('user24');
    });

    it('uses description field (not body) from GitLab response', () => {
      mockSpawnSync
        .mockReturnValueOnce(
          makeSpawnResult({
            stdout: JSON.stringify({ title: 'GL', description: 'desc text', body: 'ignored' }),
          })
        )
        .mockReturnValueOnce(makeSpawnResult({ stdout: '[]' }));

      const result = fetchIssue(parsed);

      expect(result.body).toBe('desc text');
    });

    it('uses empty strings for missing title and description fields', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({}) }))
        .mockReturnValueOnce(makeSpawnResult({ stdout: '[]' }));

      const result = fetchIssue(parsed);

      expect(result.title).toBe('');
      expect(result.body).toBe('');
    });

    it('uses empty strings for missing note author and timestamp fields', () => {
      const notes = [{ body: 'Note without author' }];

      mockSpawnSync
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify({ title: 'T', description: 'D' }) }))
        .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(notes) }));

      const result = fetchIssue(parsed);

      expect(result.comments[0]).toEqual({ author: 'unknown', createdAt: '', body: 'Note without author' });
    });
  });
});

describe('fetchIssueFromUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for a non-issue URL without calling spawnSync', () => {
    const result = fetchIssueFromUrl('https://example.com/not-an-issue');

    expect(result).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns null for an invalid URL without calling spawnSync', () => {
    const result = fetchIssueFromUrl('not-a-url');

    expect(result).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('fetches and returns IssueData for a valid GitHub issue URL', () => {
    const ghResponse = { title: 'Valid issue', body: 'Body', comments: [] };
    mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(ghResponse) }));

    const result = fetchIssueFromUrl('https://github.com/owner/repo/issues/7');

    expect(result).toMatchObject({
      title: 'Valid issue',
      body: 'Body',
      url: 'https://github.com/owner/repo/issues/7',
    });
  });

  it('fetches and returns IssueData for a valid GitLab issue URL', () => {
    const glabIssue = { title: 'GL valid', description: 'GL body' };
    mockSpawnSync
      .mockReturnValueOnce(makeSpawnResult({ stdout: JSON.stringify(glabIssue) }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: '[]' }));

    const result = fetchIssueFromUrl('https://gitlab.com/group/project/-/issues/3');

    expect(result).toMatchObject({
      title: 'GL valid',
      body: 'GL body',
    });
  });

  it('propagates IssueFetchError when fetch fails', () => {
    mockSpawnSync.mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'error' }));

    expect(() => fetchIssueFromUrl('https://github.com/owner/repo/issues/1')).toThrow(IssueFetchError);
  });
});

describe('formatIssueContext', () => {
  const baseData: IssueData = {
    title: 'My Issue Title',
    body: 'Issue body text.',
    url: 'https://github.com/owner/repo/issues/1',
    comments: [],
  };

  it('includes the section header', () => {
    const output = formatIssueContext(baseData);
    expect(output).toContain('## Source Issue Data');
  });

  it('includes the source URL in a blockquote', () => {
    const output = formatIssueContext(baseData);
    expect(output).toContain('> Fetched live from https://github.com/owner/repo/issues/1');
  });

  it('includes the issue title', () => {
    const output = formatIssueContext(baseData);
    expect(output).toContain('**Title:** My Issue Title');
  });

  it('includes the issue body when present', () => {
    const output = formatIssueContext(baseData);
    expect(output).toContain('**Body:**');
    expect(output).toContain('Issue body text.');
  });

  it('omits body section when body is empty', () => {
    const output = formatIssueContext({ ...baseData, body: '' });
    expect(output).not.toContain('**Body:**');
  });

  it('omits comments section when there are no comments', () => {
    const output = formatIssueContext(baseData);
    expect(output).not.toContain('**Comments');
  });

  it('includes comment count header when comments are present', () => {
    const data: IssueData = {
      ...baseData,
      comments: [
        { author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'First comment' },
        { author: 'bob', createdAt: '2024-01-02T00:00:00Z', body: 'Second comment' },
      ],
    };

    const output = formatIssueContext(data);

    expect(output).toContain('**Comments (2):**');
  });

  it('includes comment author and body', () => {
    const data: IssueData = {
      ...baseData,
      comments: [{ author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'Hello there' }],
    };

    const output = formatIssueContext(data);

    expect(output).toContain('**@alice**');
    expect(output).toContain('Hello there');
  });

  it('includes comment timestamp in parentheses', () => {
    const data: IssueData = {
      ...baseData,
      comments: [{ author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'Comment' }],
    };

    const output = formatIssueContext(data);

    expect(output).toContain('**@alice** (2024-01-01T00:00:00Z):');
  });

  it('omits timestamp parentheses when createdAt is empty', () => {
    const data: IssueData = {
      ...baseData,
      comments: [{ author: 'alice', createdAt: '', body: 'Comment' }],
    };

    const output = formatIssueContext(data);

    expect(output).toContain('**@alice**:');
    expect(output).not.toContain('**@alice** (');
  });

  it('separates comments with a horizontal rule', () => {
    const data: IssueData = {
      ...baseData,
      comments: [
        { author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'First' },
        { author: 'bob', createdAt: '2024-01-02T00:00:00Z', body: 'Second' },
      ],
    };

    const output = formatIssueContext(data);

    // Each comment is preceded by ---
    const separatorCount = (output.match(/^---$/gm) ?? []).length;
    expect(separatorCount).toBe(2);
  });

  it('renders multiple comments with all expected fields', () => {
    const data: IssueData = {
      ...baseData,
      comments: [
        { author: 'alice', createdAt: '2024-01-01T00:00:00Z', body: 'First comment' },
        { author: 'bob', createdAt: '', body: 'Second comment no timestamp' },
      ],
    };

    const output = formatIssueContext(data);

    expect(output).toContain('**@alice** (2024-01-01T00:00:00Z):');
    expect(output).toContain('First comment');
    expect(output).toContain('**@bob**:');
    expect(output).toContain('Second comment no timestamp');
  });

  it('returns a string (not undefined or null)', () => {
    expect(typeof formatIssueContext(baseData)).toBe('string');
  });
});

describe('IssueFetchError', () => {
  it('has name IssueFetchError', () => {
    const err = new IssueFetchError('something failed');
    expect(err.name).toBe('IssueFetchError');
  });

  it('is an instance of Error', () => {
    expect(new IssueFetchError('msg')).toBeInstanceOf(Error);
  });

  it('carries the provided message', () => {
    expect(new IssueFetchError('custom message').message).toBe('custom message');
  });
});
