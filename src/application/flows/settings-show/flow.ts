import type { Settings } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

import type { SettingsShowCtx } from '@src/application/flows/settings-show/ctx.ts';
import type { SettingsShowDeps } from '@src/application/flows/settings-show/deps.ts';

/**
 * Read the current settings. A missing settings file resolves to `DEFAULT_SETTINGS`
 * (handled inside the repository) so this never returns `not-found` for fresh installs;
 * callers can render the result without special-casing the empty state.
 */
export const createSettingsShowFlow = (deps: SettingsShowDeps): Element<SettingsShowCtx> =>
  leaf<SettingsShowCtx, undefined, Settings>('settings-show', {
    useCase: {
      async execute() {
        return deps.settingsRepo.load();
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
  });
