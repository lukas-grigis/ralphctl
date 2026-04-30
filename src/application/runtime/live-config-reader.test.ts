import { describe, expect, it } from 'vitest';

import { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import { CONFIG_DEFAULTS } from '../config/config-defaults.ts';
import type { Config } from '../config/config.ts';
import type { ConfigStorePort } from '../config/config-store-port.ts';
import { FileLiveConfigReader } from './live-config-reader.ts';

class MutableConfigStore implements ConfigStorePort {
  current: Result<Config, StorageError> = Result.ok(CONFIG_DEFAULTS);
  loadCalls = 0;

  load(): Promise<Result<Config, StorageError>> {
    this.loadCalls += 1;
    return Promise.resolve(this.current);
  }

  save(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }
}

describe('FileLiveConfigReader', () => {
  it('returns the current config from the store', async () => {
    const store = new MutableConfigStore();
    store.current = Result.ok({ ...CONFIG_DEFAULTS, evaluationIterations: 5 });
    const reader = new FileLiveConfigReader(store);

    const cfg = await reader.current();

    expect(cfg.evaluationIterations).toBe(5);
    expect(store.loadCalls).toBe(1);
  });

  it('falls back to CONFIG_DEFAULTS when the store errors', async () => {
    const store = new MutableConfigStore();
    store.current = Result.error(new StorageError({ subCode: 'io', message: 'transient blip' }));
    const reader = new FileLiveConfigReader(store);

    const cfg = await reader.current();

    expect(cfg).toEqual(CONFIG_DEFAULTS);
  });

  it('re-reads on every call (no snapshot)', async () => {
    const store = new MutableConfigStore();
    store.current = Result.ok({ ...CONFIG_DEFAULTS, evaluationIterations: 1 });
    const reader = new FileLiveConfigReader(store);

    expect((await reader.current()).evaluationIterations).toBe(1);

    store.current = Result.ok({ ...CONFIG_DEFAULTS, evaluationIterations: 7 });
    expect((await reader.current()).evaluationIterations).toBe(7);

    store.current = Result.ok({ ...CONFIG_DEFAULTS, evaluationIterations: 0 });
    expect((await reader.current()).evaluationIterations).toBe(0);

    expect(store.loadCalls).toBe(3);
  });
});
