import type { Settings } from '@src/domain/entity/settings.ts';

export interface SettingsShowCtx {
  readonly input: undefined;
  readonly output?: Settings;
}
