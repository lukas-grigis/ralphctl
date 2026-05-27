import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { DetectInstalledProvidersOptions } from '@src/integration/system/_engine/detect-cli.ts';

export interface SettingsSetProviderDeps {
  readonly settingsRepo: SettingsRepository;
  /**
   * Test seam — defaults to the production `detectInstalledProviders` from
   * `@src/integration/system/detect-cli.ts`. Tests inject a stub returning a fixed set so the
   * "ValidationError for an installed-but-missing provider" assertion does not depend on what's
   * on the host machine's PATH. The flow probes the seam on every save attempt — operators
   * who install a missing CLI then immediately re-set the provider see the gate clear without
   * restarting ralphctl.
   */
  readonly detectInstalledProviders?: (options?: DetectInstalledProvidersOptions) => Promise<ReadonlySet<AiProvider>>;
}
