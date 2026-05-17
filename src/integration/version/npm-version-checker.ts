/**
 * `createNpmVersionChecker` — implementation of {@link VersionChecker} that polls the npm
 * registry's `/<package>/latest` endpoint, caches the result on disk, and surfaces a
 * `VersionCheck` describing whether a newer release is available.
 *
 * Best-effort by design: every failure mode (network down, fetch timeout, malformed payload,
 * write failure on the cache) returns `null`. The TUI renders the banner when the result is
 * truthy and nothing otherwise — there is no error path that should reach the UI.
 *
 * Cache:
 *   - Lives at `<stateRoot>/version-check.json`.
 *   - 1 h TTL — short enough to surface a release the same day, long enough to avoid hammering
 *     the registry on every TUI launch.
 *   - Atomic write (tmp + rename) — readers either see the old content or the new content.
 *   - Invalidated automatically when the installed `current` version changes (the user
 *     upgraded the binary).
 */

import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '@src/integration/io/fs.ts';
import {
  buildVersionCheck,
  isCacheFresh,
  type VersionCheck,
  VersionCheckCacheSchema,
} from '@src/business/version/version-check.ts';
import type { VersionChecker } from '@src/business/version/version-checker.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/** Default 1 h cache TTL — same as v1's tuned value. */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
/** Hard timeout on the registry fetch. Three seconds is long enough for a slow uplink, short
 * enough that a hung request never delays the TUI. */
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

/** Just the field we need from the npm registry payload. */
const RegistryPayloadSchema = z.object({ version: z.string() });

export interface NpmVersionCheckerDeps {
  /** Where to write the cache. The bootstrap composition root passes `storage.stateRoot`. */
  readonly stateRoot: AbsolutePath;
  /** Currently installed version. Read from `core/version/cli-metadata.ts`. */
  readonly currentVersion: string;
  /** npm package name to poll. Same source. */
  readonly packageName: string;
  /** Test seam — production reads `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam — production uses `Date.now`. */
  readonly clock?: () => number;
  /** Override for tests. Defaults to {@link DEFAULT_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** Override for tests. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  readonly fetchTimeoutMs?: number;
}

const cachePath = (stateRoot: AbsolutePath): string => join(String(stateRoot), 'version-check.json');

const registryUrl = (packageName: string): string =>
  `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;

const shouldSkip = (env: NodeJS.ProcessEnv): boolean => env['NO_NETWORK'] !== undefined || env['VITEST'] !== undefined;

const readCache = async (path: string): Promise<VersionCheck | null> => {
  const raw = await readJson(path);
  if (!raw.ok) return null;
  const parsed = VersionCheckCacheSchema.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
};

const fetchLatest = async (url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const parsed = RegistryPayloadSchema.safeParse(body);
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export const createNpmVersionChecker = (deps: NpmVersionCheckerDeps): VersionChecker => {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const clock = deps.clock ?? Date.now;
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const path = cachePath(deps.stateRoot);
  const url = registryUrl(deps.packageName);

  return async () => {
    if (shouldSkip(env)) return null;

    const cached = await readCache(path);
    if (cached !== null && isCacheFresh(cached, deps.currentVersion, ttl, clock())) {
      return cached;
    }

    const latest = await fetchLatest(url, fetchImpl, timeoutMs);
    if (latest === null) return null;

    const fresh = buildVersionCheck(deps.currentVersion, latest, new Date(clock()));
    await writeJsonAtomic(path, fresh);
    return fresh;
  };
};
