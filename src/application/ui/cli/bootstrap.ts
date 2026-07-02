/**
 * Composition root for CLI invocations. Mirrors the TUI bootstrap (resolve storage paths →
 * ensure roots → load settings → wire deps) but with no log subscriber attached: CLI
 * commands are short-lived, debug provider logs aren't useful in a scripting context, and
 * errors surface via Result.error → stderr in the command actions themselves. Harness
 * signals are never forwarded anywhere because the CLI doesn't render the live signal stream
 * either — a one-shot CLI flow's `ai-signal` events simply have no subscriber.
 *
 * Surfaced as `Promise<{ deps; storage }>` because CLI commands need both the wired ports
 * (deps) and storage paths (for derivable per-flow paths like `<dataRoot>/sprints/<id>/...`).
 */

import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { wire } from '@src/application/bootstrap/wire.ts';
import {
  ensureStorageRoots,
  resolveStoragePaths,
  type StoragePaths,
} from '@src/application/bootstrap/storage-paths.ts';
import { detectLegacyLayout, renderLegacyLayoutMessage } from '@src/application/bootstrap/legacy-layout-detector.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';

export interface CliBootstrap {
  readonly deps: AppDeps;
  readonly storage: StoragePaths;
}

export const bootstrapCli = async (): Promise<CliBootstrap> => {
  const paths = resolveStoragePaths();
  if (!paths.ok) throw new Error(`storage-paths: ${paths.error.message}`);

  // Legacy-layout check runs BEFORE ensureStorageRoots so we don't materialise the
  // 0.7.0 subdir tree on top of 0.6.x data and confuse the user about what's "v2"
  // vs "v1" inside the directory. Detection is read-only; on hit we exit non-zero.
  //
  // process.exit (not exitCode) is intentional here: bootstrapCli's return type is the
  // concrete CliBootstrap object, not a Result, and every command destructures it directly
  // (`const { deps, storage } = await bootstrapCli()`) with no ok-check — there is no
  // "return" that keeps that contract. A hard exit is the only option without threading an
  // optional/Result return through every command file.
  const legacy = await detectLegacyLayout(paths.value.appRoot);
  if (legacy.kind === 'legacy-v0.6') {
    process.stderr.write(renderLegacyLayoutMessage(legacy));
    process.exit(1);
  }

  const ensured = await ensureStorageRoots(paths.value);
  if (!ensured.ok) throw new Error(`ensure-roots: ${ensured.error.message}`);

  // No data-migration splash here and NO auto-migrate: CLI one-shots can run headless (CI / pipes)
  // and the migration is gated on explicit interactive consent. The Wave-1 tolerant readers serve a
  // legacy or half-migrated tree fine, so a CLI command works unchanged on un-migrated data; the
  // interactive TUI (`tui/launch.ts`) owns the consent gate and is the only path that may mutate.

  const settingsRepo = createJsonSettingsRepository({ configRoot: paths.value.configRoot });
  const settings = await settingsRepo.load();
  if (!settings.ok) throw new Error(`settings: ${settings.error.message}`);

  const deps = wire({ storage: paths.value, settings: settings.value });
  return { deps, storage: paths.value };
};
