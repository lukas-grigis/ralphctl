/**
 * Pure value + helpers for the npm version-check feature. The TUI shows a dim banner on Home
 * and Welcome whenever a newer ralphctl is published. Everything below is best-effort: the
 * adapter that polls the registry returns `null` on every failure mode (network down, parse
 * error, timeout) so a flaky upstream never blocks startup or surfaces a stack trace.
 */

import { z } from 'zod';

export interface VersionCheck {
  /** Version currently installed (read from {@link CLI_METADATA}). */
  readonly current: string;
  /** Latest version visible on the npm registry. */
  readonly latest: string;
  /** True iff `latest > current`, computed via {@link compareVersions}. */
  readonly updateAvailable: boolean;
  /** ISO-8601 timestamp the check ran. Used by {@link isCacheFresh}. */
  readonly checkedAt: string;
}

/**
 * Persisted cache shape — same as {@link VersionCheck} on disk. Schema lives here so the
 * adapter and tests share a single decoder; a malformed cache parses as `null` and the
 * adapter just refetches.
 */
export const VersionCheckCacheSchema = z.object({
  current: z.string(),
  latest: z.string(),
  updateAvailable: z.boolean(),
  checkedAt: z.string(),
});

/**
 * Compare two dotted-numeric version strings. Returns 1 / -1 / 0 in the spirit of
 * `String.prototype.localeCompare`. Build metadata (`+…`) is ignored. On equal numbers a
 * pre-release (`1.2.3-rc.1`) sorts below the stable release, so an rc user hears about the
 * stable one; two pre-releases are not ordered against each other, since npm's `latest`
 * dist-tag is always stable — semver-flavoured, not full semver.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): { readonly parts: readonly number[]; readonly prerelease: boolean } => {
    const [core = '', ...pre] = (v.split('+')[0] ?? '').split('-');
    return { parts: core.split('.').map((x) => Number.parseInt(x, 10) || 0), prerelease: pre.length > 0 };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  return pa.prerelease ? -1 : 1;
};

/**
 * Decide whether a cached check is still authoritative. The adapter refetches when:
 *  - the cache is from a different installed version (user upgraded the binary), or
 *  - the cache is older than {@link ttlMs}.
 *
 * Splitting this out from the adapter keeps the rule unit-testable without touching the
 * filesystem or the network.
 */
export const isCacheFresh = (cache: VersionCheck, currentVersion: string, ttlMs: number, now: number): boolean => {
  if (cache.current !== currentVersion) return false;
  const checkedAtMs = Date.parse(cache.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  const age = now - checkedAtMs;
  return age >= 0 && age < ttlMs;
};

/** Build a fresh {@link VersionCheck} from the registry response. */
export const buildVersionCheck = (current: string, latest: string, now: Date): VersionCheck => ({
  current,
  latest,
  updateAvailable: compareVersions(latest, current) > 0,
  checkedAt: now.toISOString(),
});
