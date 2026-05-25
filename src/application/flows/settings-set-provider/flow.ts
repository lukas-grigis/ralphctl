import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { AiSettings, Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { defaultAiSettingsForProvider } from '@src/business/settings/defaults.ts';
import {
  detectInstalledProviders as defaultDetect,
  PROVIDER_BINARY,
  renderProviderInstallGuidance,
} from '@src/integration/system/detect-cli.ts';

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
 * For the `implement` flow the caller must supply `input.role` — implement carries a
 * generator + evaluator pair, and a provider switch only rebuilds the named role. Omitting
 * the role surfaces a `ValidationError` rather than silently rebuilding one of the two.
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
        // Availability gate runs BEFORE the schema rebuild so an unavailable provider never
        // touches disk. The probe is the same one the launch-time fail-fast helper uses, so
        // operators see a consistent gate across surfaces: a provider that fails here also
        // fails the next launch.
        const detect = deps.detectInstalledProviders ?? defaultDetect;
        const installed = await detect();
        if (!installed.has(input.provider)) {
          const settingsKey =
            input.flow === 'implement'
              ? `ai.implement.${input.role ?? 'generator'}.provider`
              : `ai.${input.flow}.provider`;
          return Result.error(
            new ValidationError({
              field: settingsKey,
              value: input.provider,
              message: `${input.provider} CLI (${PROVIDER_BINARY[input.provider]}) not on PATH — cannot set ${settingsKey}`,
              hint: renderProviderInstallGuidance(input.provider),
            })
          );
        }
        const defaultsForProvider = defaultAiSettingsForProvider(input.provider);
        let nextAi: AiSettings;
        if (input.flow === 'implement') {
          if (input.role === undefined) {
            return Result.error(
              new ValidationError({
                field: 'role',
                value: 'undefined',
                message: 'implement requires an explicit role (generator | evaluator) for a provider switch',
              })
            );
          }
          // Roles default to the same row inside `defaultAiSettingsForProvider`, so the
          // generator and evaluator entries are interchangeable here.
          const rebuiltRoleRow = defaultsForProvider.implement[input.role];
          const nextImplement = { ...current.value.ai.implement, [input.role]: rebuiltRoleRow };
          nextAi = { ...current.value.ai, implement: nextImplement } as AiSettings;
        } else {
          const rebuiltRow = defaultsForProvider[input.flow];
          nextAi = { ...current.value.ai, [input.flow]: rebuiltRow } as AiSettings;
        }
        const next: Settings = { ...current.value, ai: nextAi };
        const saved = await deps.settingsRepo.save(next);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(next);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
