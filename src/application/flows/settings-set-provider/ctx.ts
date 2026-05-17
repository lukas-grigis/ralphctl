import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';

export interface SettingsSetProviderInput {
  readonly provider: AiProvider;
}

export interface SettingsSetProviderCtx {
  readonly input: SettingsSetProviderInput;
  readonly output?: Settings;
}
