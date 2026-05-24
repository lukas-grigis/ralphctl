import type { Settings } from '@src/domain/entity/settings.ts';
import type { PresetName } from '@src/business/settings/presets.ts';

export interface SettingsApplyPresetInput {
  readonly preset: PresetName;
}

export interface SettingsApplyPresetCtx {
  readonly input: SettingsApplyPresetInput;
  readonly output?: Settings;
}
