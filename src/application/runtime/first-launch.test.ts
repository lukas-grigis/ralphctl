import { describe, expect, it } from 'vitest';

import type { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import { SprintId } from '../../domain/values/sprint-id.ts';
import { InMemoryProjectRepository } from '../../business/_test-fakes/in-memory-project-repository.ts';
import type { Config } from '../config/config.ts';
import { CONFIG_DEFAULTS } from '../config/config-defaults.ts';
import type { ConfigStorePort } from '../config/config-store-port.ts';
import { makeProject } from '../_test-fakes/fixtures.ts';
import { isFirstLaunch } from './first-launch.ts';

class StubConfigStore implements ConfigStorePort {
  constructor(private current: Config = CONFIG_DEFAULTS) {}

  load(): Promise<Result<Config, StorageError>> {
    return Promise.resolve(Result.ok(this.current));
  }

  save(config: Config): Promise<Result<void, StorageError>> {
    this.current = config;
    return Promise.resolve(Result.ok());
  }
}

describe('isFirstLaunch', () => {
  it('returns true when no projects and no current sprint', async () => {
    const projectRepo = new InMemoryProjectRepository();
    const configStore = new StubConfigStore();

    expect(await isFirstLaunch({ projectRepo, configStore })).toBe(true);
  });

  it('returns false when at least one project exists', async () => {
    const projectRepo = new InMemoryProjectRepository([makeProject()]);
    const configStore = new StubConfigStore();

    expect(await isFirstLaunch({ projectRepo, configStore })).toBe(false);
  });

  it('returns false when a current sprint is set (returning user)', async () => {
    const projectRepo = new InMemoryProjectRepository();
    const configStore = new StubConfigStore({
      ...CONFIG_DEFAULTS,
      currentSprint: SprintId.trustString('20260429-141522-demo'),
    });

    expect(await isFirstLaunch({ projectRepo, configStore })).toBe(false);
  });
});
