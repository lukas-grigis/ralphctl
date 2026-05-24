import { Result } from '@src/domain/result.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { applyPreset } from '@src/business/settings/presets.ts';

import type {
  SettingsApplyPresetCtx,
  SettingsApplyPresetInput,
} from '@src/application/flows/settings-apply-preset/ctx.ts';
import type { SettingsApplyPresetDeps } from '@src/application/flows/settings-apply-preset/deps.ts';

/**
 * Stamp a preset onto the current Settings. Loads the current record, replaces the AI
 * section with the preset's matrix (preserving harness / logging / concurrency / ui /
 * developer verbatim), and persists. No preset identity is stored — a subsequent edit to
 * any per-flow row sticks across reloads.
 *
 * The CLI's `settings apply-preset` subcommand and the TUI's preset buttons both route
 * through this flow. Schema validation runs at the persistence boundary, so a malformed
 * preset (out-of-catalog model) would surface as a `ParseError` rather than landing on
 * disk; in practice the four shipped presets are statically valid.
 */
export const createSettingsApplyPresetFlow = (deps: SettingsApplyPresetDeps): Element<SettingsApplyPresetCtx> =>
  leaf<SettingsApplyPresetCtx, SettingsApplyPresetInput, Settings>('settings-apply-preset', {
    useCase: {
      async execute(input) {
        const current = await deps.settingsRepo.load();
        if (!current.ok) return Result.error(current.error);
        const next = applyPreset(input.preset, current.value);
        const saved = await deps.settingsRepo.save(next);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(next);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
