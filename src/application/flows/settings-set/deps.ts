import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

export interface SettingsSetDeps {
  readonly settingsRepo: SettingsRepository;
}
