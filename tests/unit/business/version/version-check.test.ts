import { describe, expect, it } from 'vitest';
import {
  buildVersionCheck,
  compareVersions,
  isCacheFresh,
  VersionCheckCacheSchema,
} from '@src/business/version/version-check.ts';

describe('compareVersions', () => {
  it('returns 1 when a > b on patch', () => {
    expect(compareVersions('1.2.3', '1.2.2')).toBe(1);
  });
  it('returns -1 when a < b on minor', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBe(-1);
  });
  it('returns 0 when equal', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });
  it('strips pre-release suffixes before comparing', () => {
    // 1.2.3 == 1.2.3-alpha for our purposes (registry `latest` is always a stable release).
    expect(compareVersions('1.2.3', '1.2.3-alpha')).toBe(0);
  });
  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });
  it('handles non-numeric segments by parsing as zero', () => {
    expect(compareVersions('1.2.abc', '1.2.0')).toBe(0);
  });
});

describe('isCacheFresh', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const cache = {
    current: '0.1.0',
    latest: '0.2.0',
    updateAvailable: true,
    checkedAt: '2026-01-15T11:30:00Z', // 30 min ago
  };

  it('is fresh when cache is younger than ttl and current matches', () => {
    expect(isCacheFresh(cache, '0.1.0', 60 * 60 * 1000, now)).toBe(true);
  });

  it('is stale when cache TTL exceeded', () => {
    const old = { ...cache, checkedAt: '2026-01-15T10:00:00Z' }; // 2h ago
    expect(isCacheFresh(old, '0.1.0', 60 * 60 * 1000, now)).toBe(false);
  });

  it('is stale when current version no longer matches the cached one', () => {
    expect(isCacheFresh(cache, '0.2.0', 60 * 60 * 1000, now)).toBe(false);
  });

  it('is stale when checkedAt is unparseable', () => {
    const broken = { ...cache, checkedAt: 'not-an-iso-string' };
    expect(isCacheFresh(broken, '0.1.0', 60 * 60 * 1000, now)).toBe(false);
  });

  it('is stale when checkedAt is in the future (clock skew)', () => {
    const future = { ...cache, checkedAt: '2027-01-01T00:00:00Z' };
    expect(isCacheFresh(future, '0.1.0', 60 * 60 * 1000, now)).toBe(false);
  });
});

describe('buildVersionCheck', () => {
  it('marks update available when latest > current', () => {
    const result = buildVersionCheck('1.0.0', '1.0.1', new Date('2026-01-15T12:00:00Z'));
    expect(result.updateAvailable).toBe(true);
    expect(result.current).toBe('1.0.0');
    expect(result.latest).toBe('1.0.1');
    expect(result.checkedAt).toBe('2026-01-15T12:00:00.000Z');
  });

  it('does not mark an update when versions are equal', () => {
    const result = buildVersionCheck('1.0.0', '1.0.0', new Date('2026-01-15T12:00:00Z'));
    expect(result.updateAvailable).toBe(false);
  });

  it('does not mark an update when registry is older than installed (downgrade)', () => {
    const result = buildVersionCheck('1.1.0', '1.0.0', new Date('2026-01-15T12:00:00Z'));
    expect(result.updateAvailable).toBe(false);
  });
});

describe('VersionCheckCacheSchema', () => {
  it('parses a well-formed cache shape', () => {
    const parsed = VersionCheckCacheSchema.safeParse({
      current: '0.1.0',
      latest: '0.2.0',
      updateAvailable: true,
      checkedAt: '2026-01-15T12:00:00Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing fields', () => {
    const parsed = VersionCheckCacheSchema.safeParse({ current: '0.1.0' });
    expect(parsed.success).toBe(false);
  });
});
