import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { PresetName } from '@src/business/settings/presets.ts';

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
}

export interface SettingsApplyPresetCtx {
  readonly input: SettingsApplyPresetInput;
  readonly output?: SettingsApplyPresetOutput;
}
