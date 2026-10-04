import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { ModelSubstitution, UnavailableModel } from '@src/business/settings/adapt-to-available-models.ts';

export interface SettingsApplyPresetInput {
  readonly preset: PresetName;
}

/**
 * One warning per provider configured in the freshly-stamped settings whose CLI binary did not
 * resolve on `PATH` at apply-time. `flows` lists every per-flow row that resolved to the
 * missing provider, so the CLI / TUI can surface "codex CLI missing — affects refine".
 */
export interface PresetWarning {
  readonly provider: AiProvider;
  readonly flows: readonly FlowId[];
}

export interface SettingsApplyPresetOutput {
  readonly settings: Settings;
  readonly warnings: readonly PresetWarning[];
  /** Rows moved to a stand-in because the account can't run the preset's model. */
  readonly substitutions: readonly ModelSubstitution[];
  /** Rows whose model the account can't run and that had no available stand-in. */
  readonly unavailable: readonly UnavailableModel[];
}

/** What a surface shows after an apply: missing CLIs plus the model swaps. */
export type PresetNotices = Pick<SettingsApplyPresetOutput, 'warnings' | 'substitutions' | 'unavailable'>;

export const NO_PRESET_NOTICES: PresetNotices = { warnings: [], substitutions: [], unavailable: [] };

export interface SettingsApplyPresetCtx {
  readonly input: SettingsApplyPresetInput;
  readonly output?: SettingsApplyPresetOutput;
}
