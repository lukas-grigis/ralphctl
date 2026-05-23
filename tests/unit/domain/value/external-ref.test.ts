import { describe, expect, it } from 'vitest';
import { normalizeRefs, parseExternalRefFromUrl } from '@src/domain/value/external-ref.ts';

describe('parseExternalRefFromUrl', () => {
  it('returns #<n> for a GitHub issue URL', () => {
    expect(parseExternalRefFromUrl('https://github.com/foo/bar/issues/42')).toBe('#42');
  });

  it('returns #<n> for a GitLab issue URL with a single-segment group', () => {
    expect(parseExternalRefFromUrl('https://gitlab.com/grp/proj/-/issues/7')).toBe('#7');
  });

  it('returns #<n> for a GitLab issue URL with a multi-segment group', () => {
    expect(parseExternalRefFromUrl('https://gitlab.com/grp/sub/proj/-/issues/99')).toBe('#99');
  });

  it('returns #<n> for a self-hosted GitLab issue URL', () => {
    expect(parseExternalRefFromUrl('https://gitlab.example.com/team/svc/-/issues/3')).toBe('#3');
  });

  it('returns undefined for a GitHub pull-request URL', () => {
    expect(parseExternalRefFromUrl('https://github.com/foo/bar/pull/42')).toBeUndefined();
  });

  it('returns undefined for a GitLab merge-request URL', () => {
    expect(parseExternalRefFromUrl('https://gitlab.com/grp/proj/-/merge_requests/3')).toBeUndefined();
  });

  it('returns undefined for an unrecognised host', () => {
    expect(parseExternalRefFromUrl('https://example.com/foo/bar/issues/1')).toBeUndefined();
  });

  it('returns undefined for non-http(s) protocols', () => {
    expect(parseExternalRefFromUrl('ftp://github.com/foo/bar/issues/1')).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(parseExternalRefFromUrl('not a url')).toBeUndefined();
  });

  it('returns undefined when the issue number is missing or zero', () => {
    expect(parseExternalRefFromUrl('https://github.com/foo/bar/issues/0')).toBeUndefined();
    expect(parseExternalRefFromUrl('https://github.com/foo/bar/issues/abc')).toBeUndefined();
    expect(parseExternalRefFromUrl('https://github.com/foo/bar/issues')).toBeUndefined();
  });
});

describe('normalizeRefs', () => {
  it('returns an empty array for undefined input', () => {
    expect(normalizeRefs(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty input array', () => {
    expect(normalizeRefs([])).toEqual([]);
  });

  it('trims surrounding whitespace on each entry', () => {
    expect(normalizeRefs(['  #123  ', '\tPROJ-7\n'])).toEqual(['#123', 'PROJ-7']);
  });

  it('drops whitespace-only and empty entries', () => {
    expect(normalizeRefs(['#123', '', '   ', '\t', '!456'])).toEqual(['#123', '!456']);
  });

  it('dedupes repeated refs first-seen-wins, preserving input order', () => {
    expect(normalizeRefs(['#123', '!456', '#123', '!456', '#789'])).toEqual(['#123', '!456', '#789']);
  });

  it('treats trimmed equivalents as duplicates', () => {
    expect(normalizeRefs(['#123', '  #123  ', '#123\n'])).toEqual(['#123']);
  });

  it('returns empty when every entry is whitespace-only', () => {
    expect(normalizeRefs(['  ', '\t', ''])).toEqual([]);
  });
});
