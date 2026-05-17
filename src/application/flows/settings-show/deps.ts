import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

export interface SettingsShowDeps {
  readonly settingsRepo: SettingsRepository;
}
