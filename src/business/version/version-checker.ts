/**
 * npm update check, polled on Home / Welcome mount. Best-effort, never throws: `null` when
 * `NO_NETWORK` / `VITEST` is set, the cache is current, or the fetch or payload fails.
 */

import type { VersionCheck } from '@src/business/version/version-check.ts';

export type VersionChecker = () => Promise<VersionCheck | null>;
