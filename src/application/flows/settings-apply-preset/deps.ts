import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';

export interface SettingsApplyPresetDeps {
  readonly settingsRepo: SettingsRepository;
}
