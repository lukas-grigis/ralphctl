import { describe, expect, it } from 'vitest';
import { type ExternalIssue, formatIssueContext } from '@src/business/scm/issue-fetcher.ts';

describe('formatIssueContext', () => {
  it('renders GitLab issue comments under the Source Issue Data section', () => {
    const issue: ExternalIssue = {
      url: 'https://gitlab.com/foo/bar/-/issues/5',
      title: 'GLab issue',
      body: 'desc body',
      state: 'open',
      comments: [
        { author: 'alice', body: 'first reply' },
        { author: 'bob', body: 'second reply' },
      ],
    };

    const out = formatIssueContext(issue);

    expect(out).toContain('## Source Issue Data');
    expect(out).toContain('**Comments (2):**');
    expect(out).toContain('**@alice**:');
    expect(out).toContain('first reply');
    expect(out).toContain('**@bob**:');
    expect(out).toContain('second reply');
  });
});
