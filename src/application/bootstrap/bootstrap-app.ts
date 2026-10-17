/** Shared pre-flight + composition for the CLI and the bare-`ralphctl` TUI: storage, legacy-layout check, settings, `wire()`. */

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
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

export interface AppBootstrap {
  readonly deps: AppDeps;
  readonly storage: StoragePaths;
}

export interface BootstrapAppOptions {
  /** Replaces the AI adapters' spawn; see `AppDeps.providerSpawn`. */
  readonly providerSpawn?: ProviderSpawn;
}

export const bootstrapApp = async (options: BootstrapAppOptions = {}): Promise<AppBootstrap> => {
  const paths = resolveStoragePaths();
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);

  // Legacy-layout check runs BEFORE ensureStorageRoots (and, for the TUI, before the Ink mount) so we don't
  // materialise the 0.7.0 subdir tree on top of 0.6.x data and the recovery message lands on the regular terminal.
  const legacy = await detectLegacyLayout(paths.value.appRoot);
  if (legacy.kind === 'legacy-v0.6') {
    process.stderr.write(renderLegacyLayoutMessage(legacy));
    // process.exit on purpose: every caller destructures bootstrapApp() unchecked.
    process.exit(1);
  }

  const ensured = await ensureStorageRoots(paths.value);
  if (!ensured.ok) throw new Error(`ensure-roots: ${ensured.error.message}`);

  // No data-migration splash here and NO auto-migrate: CLI one-shots can run headless (CI / pipes) and the migration
  // is gated on explicit interactive consent, which only the TUI launch owns.

  const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
  const settings = await settingsRepo.load();
  // The repair hint is the actionable half of a bad-settings failure ("fix or delete settings.json …").
  if (!settings.ok) {
    const hint = 'hint' in settings.error && settings.error.hint !== undefined ? ` (${settings.error.hint})` : '';
    throw new Error(`settings: ${settings.error.message}${hint}`);
  }

  const deps = wire({
    storage: paths.value,
    settings: settings.value,
    ...(options.providerSpawn !== undefined ? { providerSpawn: options.providerSpawn } : {}),
  });

  // Runs once per process: a CLI invocation is one subcommand per process and `launchTui` is the single bare-`ralphctl`
  // entry point, so each calls this exactly once. See run-bundle-integrity-check.ts for the full story.
  await runBundleIntegrityCheck(deps.logger);

  return { deps, storage: paths.value };
};
