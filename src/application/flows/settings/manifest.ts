import type { FlowManifest } from '@src/application/registry.ts';

/**
 * Menu manifest for the Settings entry. There is no chain flow under this id — the TUI routes
 * directly to `SettingsView`, which composes the `settings-show` / `settings-set` /
 * `settings-set-provider` primitives. The CLI exposes those primitives as `settings show` /
 * `settings set` subcommands of the `settings` verb, so the manifest id matches the CLI verb.
 */
export const settingsManifest: FlowManifest = {
  id: 'settings',
  title: 'Settings',
  description: 'Inspect and mutate ralphctl settings (provider, models, harness budgets, logging, concurrency).',
  canBackground: false,
  triggers: {},
};
