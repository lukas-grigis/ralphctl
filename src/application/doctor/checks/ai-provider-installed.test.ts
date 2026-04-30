import { describe, expect, it } from 'vitest';

import type { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import { CONFIG_DEFAULTS } from '../../config/config-defaults.ts';
import type { Config } from '../../config/config.ts';
import type { ConfigStorePort } from '../../config/config-store-port.ts';
import { aiProviderInstalledCheck } from './ai-provider-installed.ts';

class FakeConfigStore implements ConfigStorePort {
  constructor(private readonly cfg: Config | StorageError) {}
  load(): Promise<Result<Config, StorageError>> {
    return Promise.resolve(this.cfg instanceof Error ? Result.error(this.cfg) : Result.ok(this.cfg));
  }
  save(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }
}

describe('aiProviderInstalledCheck', () => {
  it('returns skip when no provider is configured', async () => {
    const r = await aiProviderInstalledCheck({
      configStore: new FakeConfigStore(CONFIG_DEFAULTS),
    });
    expect(r.name).toBe('AI provider binary');
    expect(r.status).toBe('skip');
    expect(r.message).toBe('not configured');
  });

  it('returns pass or fail when claude is configured (depending on PATH)', async () => {
    const r = await aiProviderInstalledCheck({
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'claude' }),
    });
    expect(r.name).toBe('AI provider binary');
    expect(['pass', 'fail']).toContain(r.status);
    expect(r.message).toContain('claude');
  });

  it('returns pass or fail when copilot is configured (depending on PATH)', async () => {
    const r = await aiProviderInstalledCheck({
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, aiProvider: 'copilot' }),
    });
    expect(r.name).toBe('AI provider binary');
    expect(['pass', 'fail']).toContain(r.status);
    expect(r.message).toContain('copilot');
  });
});
