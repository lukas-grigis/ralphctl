import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { DetectInstalledProvidersOptions } from '@src/integration/system/_engine/detect-cli.ts';
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
  /**
   * Live per-provider model list (`AppDeps.availableModelsFor`). When present, preset rows the
   * account can't run move to a stand-in before saving; omit it to stamp the preset verbatim.
   */
  readonly availableModelsFor?: (provider: AiProvider) => Promise<readonly string[]>;
}
