/** Composition root for CLI invocations. */

import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import {
  ensureStorageRoots,
  resolveStoragePaths,
  type StoragePaths,
} from '@src/application/bootstrap/storage-paths.ts';
import { detectLegacyLayout, renderLegacyLayoutMessage } from '@src/application/bootstrap/legacy-layout-detector.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { runBundleIntegrityCheck } from '@src/application/bootstrap/run-bundle-integrity-check.ts';

export interface CliBootstrap {
  readonly deps: AppDeps;
  readonly storage: StoragePaths;
}

export const bootstrapCli = async (): Promise<CliBootstrap> => {
  const paths = resolveStoragePaths();
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);

  // Legacy-layout check runs BEFORE ensureStorageRoots so we don't materialise the 0.7.0 subdir tree on top of 0.6.x
  // data and confuse the user about what's "v2" vs "v1" inside the directory.
  const legacy = await detectLegacyLayout(paths.value.appRoot);
  if (legacy.kind === 'legacy-v0.6') {
    process.stderr.write(renderLegacyLayoutMessage(legacy));
    // process.exit on purpose: every command destructures bootstrapCli() unchecked.
    process.exit(1);
  }

  const ensured = await ensureStorageRoots(paths.value);
  if (!ensured.ok) throw new Error(`ensure-roots: ${ensured.error.message}`);

  // No data-migration splash here and NO auto-migrate: CLI one-shots can run headless (CI / pipes) and the migration
  // is gated on explicit interactive consent.

  const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
  const settings = await settingsRepo.load();
  // The repair hint is the actionable half of a bad-settings failure ("fix or delete settings.json …").
  if (!settings.ok) {
    const hint = 'hint' in settings.error && settings.error.hint !== undefined ? ` (${settings.error.hint})` : '';
    throw new Error(`settings: ${settings.error.message}${hint}`);
  }

  const deps = wire({ storage: paths.value, settings: settings.value });

  // Runs once per process: a CLI invocation is one subcommand per process, and `bootstrapCli`
  // is called exactly once per invocation. See run-bundle-integrity-check.ts for the full story.
  await runBundleIntegrityCheck(deps.logger);

  return { deps, storage: paths.value };
};
