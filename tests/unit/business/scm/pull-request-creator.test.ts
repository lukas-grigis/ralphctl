import { describe, expect, it } from 'vitest';
import {
  detectPullRequestPlatform,
  parseRemoteHostname,
  parseUrlFromCliStdout,
} from '@src/business/scm/pull-request-creator.ts';

describe('parseRemoteHostname', () => {
  it('parses HTTPS remotes', () => {
    expect(parseRemoteHostname('https://github.com/owner/repo.git')).toBe('github.com');
  });

  it('parses SSH remotes', () => {
    expect(parseRemoteHostname('git@github.com:owner/repo.git')).toBe('github.com');
  });

  it('parses git+ssh remotes', () => {
    expect(parseRemoteHostname('git+ssh://git@gitlab.example.com/owner/repo.git')).toBe('gitlab.example.com');
  });

  it('returns null on unparseable strings', () => {
    expect(parseRemoteHostname('')).toBeNull();
    expect(parseRemoteHostname('not a url')).toBeNull();
  });
});

describe('detectPullRequestPlatform', () => {
  it('matches github.com and subdomains', () => {
    expect(detectPullRequestPlatform('https://github.com/o/r.git')).toBe('github');
    expect(detectPullRequestPlatform('git@enterprise.github.com:o/r.git')).toBe('github');
  });

  it('matches gitlab.com, gitlab.* prefix, and *.gitlab.* substring', () => {
    expect(detectPullRequestPlatform('https://gitlab.com/o/r.git')).toBe('gitlab');
    expect(detectPullRequestPlatform('git@gitlab.example.com:o/r.git')).toBe('gitlab');
    expect(detectPullRequestPlatform('https://internal.gitlab.corp/o/r.git')).toBe('gitlab');
  });

  it('returns null for unrecognised hosts', () => {
    expect(detectPullRequestPlatform('https://bitbucket.org/o/r.git')).toBeNull();
    expect(detectPullRequestPlatform('https://example.com/o/r.git')).toBeNull();
  });

  it('returns null when the hostname cannot be parsed', () => {
    expect(detectPullRequestPlatform('')).toBeNull();
  });
});

describe('parseUrlFromCliStdout', () => {
  it('returns the last https:// line in stdout', () => {
    const out = ['Creating pull request...', 'https://github.com/o/r/pull/42', ''].join('\n');
    expect(parseUrlFromCliStdout(out)).toBe('https://github.com/o/r/pull/42');
  });

  it('prefers a URL line even when noisy progress lines follow', () => {
    const out = ['progress', 'https://gitlab.com/o/r/-/merge_requests/7', 'remote: done'].join('\n');
    expect(parseUrlFromCliStdout(out)).toBe('https://gitlab.com/o/r/-/merge_requests/7');
  });

  it('falls back to the last non-empty line when no https URL is found', () => {
    expect(parseUrlFromCliStdout('plain text\nlast line')).toBe('last line');
  });

  it('returns null on empty stdout', () => {
    expect(parseUrlFromCliStdout('')).toBeNull();
    expect(parseUrlFromCliStdout('   \n  \n')).toBeNull();
  });
});
