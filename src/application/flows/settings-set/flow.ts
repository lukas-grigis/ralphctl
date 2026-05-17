import { Result } from '@src/domain/result.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { SettingsSetCtx, SettingsSetInput } from '@src/application/flows/settings-set/ctx.ts';
import type { SettingsSetDeps } from '@src/application/flows/settings-set/deps.ts';

/**
 * Persist a new settings record. The repository validates against `SettingsSchema`, so an
 * invalid `next` (out-of-range numbers, unknown enum members, provider/model mismatch) surfaces
 * as a `ParseError(schema-mismatch)` rather than landing on disk.
 *
 * Callers are responsible for read-modify-write: load via `settings-show`, mutate, then pass
 * the full result here. Coordinated changes land in their own flows (see settings-set-provider).
 */
export const createSettingsSetFlow = (deps: SettingsSetDeps): Element<SettingsSetCtx> =>
  leaf<SettingsSetCtx, SettingsSetInput, Settings>('settings-set', {
    useCase: {
      async execute(input) {
        const saved = await deps.settingsRepo.save(input.next);
        if (!saved.ok) return Result.error(saved.error);
        return Result.ok(input.next);
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
