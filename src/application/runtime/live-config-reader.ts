/**
 * `LiveConfigReader` — re-reads {@link Config} fresh on every call.
 *
 * The motivation is REQ-12 (live config, no snapshot): mid-execution edits
 * to `evaluationIterations` (or any other config key) made via the settings
 * panel must take effect on the next task settlement without restarting the
 * sprint runner. The legacy stack achieved this by calling
 * `PersistencePort.getConfig()` inside the per-task settlement loop; the
 * chain layer does the same here through this reader so use cases stay
 * agnostic of the application-level `ConfigStorePort`.
 *
 * Falls back to {@link CONFIG_DEFAULTS} on any store error so a transient
 * read failure can never strand the loop with stale values — the loop
 * keeps moving with sane defaults rather than crashing on a config blip.
 */
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import type { Config } from '@src/application/config/config.ts';
import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';

export interface LiveConfigReader {
  /** Re-reads config fresh on every call; falls back to defaults on error. */
  current(): Promise<Config>;
}

export class FileLiveConfigReader implements LiveConfigReader {
  constructor(private readonly store: ConfigStorePort) {}

  async current(): Promise<Config> {
    const result = await this.store.load();
    return result.ok ? result.value : CONFIG_DEFAULTS;
  }
}
