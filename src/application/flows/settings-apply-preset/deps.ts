import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { DetectInstalledProvidersOptions } from '@src/integration/system/detect-cli.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

export interface SettingsApplyPresetDeps {
  readonly settingsRepo: SettingsRepository;
  /**
   * Test seam — defaults to the production `detectInstalledProviders` from
   * `@src/integration/system/detect-cli.ts`. Tests inject a stub returning a fixed set so the
   * "warning for codex when codex is absent" assertion does not depend on what's on the host
   * machine's PATH.
   */
  readonly detectInstalledProviders?: (options?: DetectInstalledProvidersOptions) => Promise<ReadonlySet<AiProvider>>;
}
