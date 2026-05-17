/**
 * Output port for the npm version-check feature. The TUI calls this on Home / Welcome mount;
 * the implementation polls the npm registry, caches the result, and returns `null` on every
 * failure mode (offline, parse error, timeout). Never throws.
 *
 * Resolves to `null` when:
 *  - `NO_NETWORK` or `VITEST` env is set,
 *  - the cache is valid and matches the current version,
 *  - the registry fetch fails / times out,
 *  - the response payload is malformed.
 *
 * Best-effort by contract — callers render the dim banner when truthy and render nothing
 * otherwise.
 */

import type { VersionCheck } from '@src/business/version/version-check.ts';

export type VersionChecker = () => Promise<VersionCheck | null>;
