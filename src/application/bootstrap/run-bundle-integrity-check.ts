/**
 * Shared bundle-integrity pre-flight — run once per process by both composition roots
 * (`ui/cli/bootstrap.ts`'s `bootstrapCli` and `ui/tui/launch.ts`'s `bootstrap`), immediately
 * after `wire()` so `deps.logger` is available for the malformed-manifest warning path.
 *
 * Bundle-mode-only: `checkBundleIntegrity` is a silent no-op in dev (`tsx`), where there is no
 * `dist/manifest.json` beside the running module. A hard failure (missing asset / version
 * mismatch) throws, mirroring the `paths` / `ensureStorageRoots` / `settingsRepo.load()`
 * pre-flights it sits beside at each call site — the CLI bootstrap leaves it uncaught (existing
 * behaviour for every pre-flight there), `launchTui` catches it into a one-line stderr message.
 * A malformed manifest logs at warning level and never blocks startup.
 */

import type { Logger } from '@src/business/observability/logger.ts';
import { checkBundleIntegrity } from '@src/integration/system/bundle-integrity.ts';

export const runBundleIntegrityCheck = async (logger: Logger): Promise<void> => {
  const result = await checkBundleIntegrity();
  if (!result.ok) throw new Error(`bundle-integrity: ${result.error.message}`);
  if (result.value.kind === 'malformed') {
    logger.warn(`bundle-integrity: ${result.value.reason}`);
  }
};
