import type { Settings } from '@src/domain/entity/settings.ts';

export interface SettingsSetInput {
  /** The full next Settings record. Schema validation happens at the repository boundary. */
  readonly next: Settings;
}

export interface SettingsSetCtx {
  readonly input: SettingsSetInput;
  readonly output?: Settings;
}
