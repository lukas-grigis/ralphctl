import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

export interface SettingsSetProviderInput {
  /** Which flow row to rebuild — settings.ai is now per-flow, so a switch targets one row. */
  readonly flow: FlowId;
  readonly provider: AiProvider;
}

export interface SettingsSetProviderCtx {
  readonly input: SettingsSetProviderInput;
  readonly output?: Settings;
}
