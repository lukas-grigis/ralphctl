/**
 * npm version check — polls the npm registry for a newer ralphctl release and
 * caches the result under the data directory.
 *
 * Everything is best-effort: this must never block startup, never throw, and
 * never fail the app if the network is down. The Ink TUI renders a dim hint
 * when a newer version is available; on any problem we silently return null.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cliMetadata } from '@src/domain/cli-metadata.ts';
import { getDataDir } from '@src/integration/persistence/paths.ts';

export interface VersionCheck {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
  readonly checkedAt: string; // ISO8601
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const FETCH_TIMEOUT_MS = 3000;
const REGISTRY_URL = 'https://registry.npmjs.org/ralphctl/latest';

function getCachePath(): string {
  return join(getDataDir(), 'version-check.json');
}

/** Compare two dotted numeric version strings. Returns 1/-1/0. Pre-release/suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => (v.split('-')[0] ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function readCache(): Promise<VersionCheck | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VersionCheck>;
    if (
      typeof parsed.current !== 'string' ||
      typeof parsed.latest !== 'string' ||
      typeof parsed.updateAvailable !== 'boolean' ||
      typeof parsed.checkedAt !== 'string'
    ) {
      return null;
    }
    return parsed as VersionCheck;
  } catch {
    return null;
  }
}

async function writeCache(check: VersionCheck): Promise<void> {
  const path = getCachePath();
  const tmp = `${path}.${String(process.pid)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(check, null, 2), 'utf-8');
    await rename(tmp, path);
  } catch {
    // best-effort — caching failure isn't fatal
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve whether a newer ralphctl exists on npm.
 *
 * Returns a cached result if it is fresh (<24h) and matches the current
 * installed version. Otherwise fetches the registry with a 3s timeout, writes
 * the cache atomically, and returns the fresh result. Returns `null` when:
 *   - `NO_NETWORK` or `VITEST` is set
 *   - the fetch times out or errors
 *   - the registry response is malformed
 */
export async function checkLatestVersion(): Promise<VersionCheck | null> {
  if (process.env['NO_NETWORK'] || process.env['VITEST']) return null;

  const current = cliMetadata.version;
  const cached = await readCache();
  if (cached !== null && cached.current === current) {
    const age = Date.now() - Date.parse(cached.checkedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      return cached;
    }
  }

  const latest = await fetchLatest();
  if (latest === null) return null;

  const result: VersionCheck = {
    current,
    latest,
    updateAvailable: compareVersions(latest, current) > 0,
    checkedAt: new Date().toISOString(),
  };
  await writeCache(result);
  return result;
}
