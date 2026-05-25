import type { AiImplementRole, AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

export interface SettingsSetProviderInput {
  /** Which flow row to rebuild — settings.ai is now per-flow, so a switch targets one row. */
  readonly flow: FlowId;
  readonly provider: AiProvider;
  /**
   * Implement-only — selects whether to rebuild the generator or evaluator role. Required
   * when `flow === 'implement'`; ignored otherwise. Omitting it on the implement flow is a
   * caller error caught at runtime by the flow.
   */
  readonly role?: AiImplementRole;
}

export interface SettingsSetProviderCtx {
  readonly input: SettingsSetProviderInput;
  readonly output?: Settings;
}
