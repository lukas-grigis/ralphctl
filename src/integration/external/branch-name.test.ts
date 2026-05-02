import { describe, expect, it } from 'vitest';

import { generateBranchName, isValidBranchName } from './branch-name.ts';

describe('isValidBranchName', () => {
  it.each(['feature/foo', 'feature_bar', 'feature.bar', 'ralphctl/20260429-101010-thing', 'topic-1', 'a'])(
    'accepts %s',
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    }
  );

  it.each([
    ['empty', ''],
    ['leading hyphen', '-foo'],
    ['consecutive dots', 'foo..bar'],
    ['trailing dot', 'foo.'],
    ['trailing slash', 'foo/'],
    ['lock suffix', 'foo.lock'],
    ['empty segment', 'foo//bar'],
    ['space', 'foo bar'],
    ['caret', 'foo^bar'],
    ['tilde', 'foo~bar'],
    ['colon', 'foo:bar'],
    ['question mark', 'foo?bar'],
    ['asterisk', 'foo*bar'],
    ['backslash', 'foo\\bar'],
    ['control char', 'foobar'],
  ])('rejects %s', (_label, name) => {
    expect(isValidBranchName(name)).toBe(false);
  });

  it('rejects names longer than 250 chars', () => {
    expect(isValidBranchName('a'.repeat(251))).toBe(false);
  });

  it('accepts names exactly 250 chars long', () => {
    expect(isValidBranchName('a'.repeat(250))).toBe(true);
  });
});

describe('generateBranchName', () => {
  it('prefixes the sprint id with `ralphctl/`', () => {
    expect(generateBranchName('20260429-141500-fix-bug')).toBe('ralphctl/20260429-141500-fix-bug');
  });

  it('produces names that pass isValidBranchName', () => {
    const sprintId = '20260429-141500-fix-bug';
    expect(isValidBranchName(generateBranchName(sprintId))).toBe(true);
  });
});
