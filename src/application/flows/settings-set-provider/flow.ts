import { Result } from '@src/domain/result.ts';
import type { AiSettings, Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';

import type {
  SettingsSetProviderCtx,
  SettingsSetProviderInput,
} from '@src/application/flows/settings-set-provider/ctx.ts';
import type { SettingsSetProviderDeps } from '@src/application/flows/settings-set-provider/deps.ts';

/**
 * Switch ONE flow row's provider. Rebuilds that row's `{ provider, model }` from the target
 * provider's defaults so `model` stays coherent with the provider's catalog (the persistence
 * schema's per-row discriminated union would otherwise reject the save). Other flow rows are
 * left untouched.
 *
 * Whole-record "reset every flow to this provider" is now expressible only via a settings
 * preset (T3) — this use-case does not retain that behaviour.
 *
 * Preserves `harness`, `logging`, `concurrency`, `ui`, `developer`, and the global `ai.effort`
 * from the current record.
 */
export const createSettingsSetProviderFlow = (deps: SettingsSetProviderDeps): Element<SettingsSetProviderCtx> =>
  leaf<SettingsSetProviderCtx, SettingsSetProviderInput, Settings>('settings-set-provider', {
    useCase: {
      async execute(input) {
        const current = await deps.settingsRepo.load();
        if (!current.ok) return Result.error(current.error);
        const rebuiltRow = defaultAiSettingsForProvider(input.provider)[input.flow];
        const nextAi: AiSettings = { ...current.value.ai, [input.flow]: rebuiltRow } as AiSettings;
        const next: Settings = { ...current.value, ai: nextAi };
        const saved = await deps.settingsRepo.save(next);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(next);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
