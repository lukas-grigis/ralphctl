import { Result } from '@src/domain/result.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { DEFAULT_AI_SETTINGS_BY_PROVIDER } from '@src/business/settings/defaults.ts';

import type {
  SettingsSetProviderCtx,
  SettingsSetProviderInput,
} from '@src/application/flows/settings-set-provider/ctx.ts';
import type { SettingsSetProviderDeps } from '@src/application/flows/settings-set-provider/deps.ts';

/**
 * Switch the configured AI provider. Rebuilds the entire `ai` block from
 * `DEFAULT_AI_SETTINGS_BY_PROVIDER` so the four model selections stay coherent with the
 * persistence schema's discriminated union — changing `ai.provider` alone would leave models
 * pointing at another provider's enum and be rejected at save time.
 *
 * Preserves `harness`, `logging`, `concurrency` from the current record.
 */
export const createSettingsSetProviderFlow = (deps: SettingsSetProviderDeps): Element<SettingsSetProviderCtx> =>
  leaf<SettingsSetProviderCtx, SettingsSetProviderInput, Settings>('settings-set-provider', {
    useCase: {
      async execute(input) {
        const current = await deps.settingsRepo.load();
        if (!current.ok) return Result.error(current.error);
        const next: Settings = {
          ...current.value,
          ai: DEFAULT_AI_SETTINGS_BY_PROVIDER[input.provider],
        };
        const saved = await deps.settingsRepo.save(next);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(next);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
