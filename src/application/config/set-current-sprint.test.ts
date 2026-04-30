import { describe, expect, it } from 'vitest';

import { InMemorySprintRepository } from '../../business/_test-fakes/in-memory-sprint-repository.ts';
import { Sprint } from '../../domain/entities/sprint.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { Slug } from '../../domain/values/slug.ts';
import { SprintId } from '../../domain/values/sprint-id.ts';
import { CONFIG_DEFAULTS } from './config-defaults.ts';
import type { Config } from './config.ts';
import type { ConfigStorePort } from './config-store-port.ts';
import { SetCurrentSprintUseCase } from './set-current-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function draftSprint(name: string, slugStr: string): Sprint {
  const r = Sprint.create({ name, slug: slug(slugStr), now: T0 });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

class InMemoryConfigStore implements ConfigStorePort {
  current: Config;
  constructor(initial: Config = CONFIG_DEFAULTS) {
    this.current = initial;
  }
  load(): Promise<Result<Config, StorageError>> {
    return Promise.resolve(Result.ok(this.current));
  }
  save(config: Config): Promise<Result<void, StorageError>> {
    this.current = config;
    return Promise.resolve(Result.ok());
  }
}

describe('SetCurrentSprintUseCase', () => {
  it('sets the current sprint pointer when the sprint exists', async () => {
    const s = draftSprint('A', 'a');
    const sprintRepo = new InMemorySprintRepository([s]);
    const configStore = new InMemoryConfigStore();
    const uc = new SetCurrentSprintUseCase(sprintRepo, configStore);

    const result = await uc.execute({ id: s.id });
    expect(result.ok).toBe(true);
    expect(configStore.current.currentSprint).toBe(s.id);
  });

  it('clears the current sprint pointer when null is passed', async () => {
    const s = draftSprint('A', 'a');
    const sprintRepo = new InMemorySprintRepository([s]);
    const configStore = new InMemoryConfigStore({ ...CONFIG_DEFAULTS, currentSprint: s.id });
    const uc = new SetCurrentSprintUseCase(sprintRepo, configStore);

    const result = await uc.execute({ id: null });
    expect(result.ok).toBe(true);
    expect(configStore.current.currentSprint).toBeNull();
  });

  it('returns NotFoundError when the target sprint does not exist', async () => {
    const sprintRepo = new InMemorySprintRepository();
    const configStore = new InMemoryConfigStore();
    const uc = new SetCurrentSprintUseCase(sprintRepo, configStore);

    const result = await uc.execute({
      id: SprintId.trustString('20260101-000000-missing'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    // Config must be unchanged.
    expect(configStore.current.currentSprint).toBeNull();
  });

  it('preserves other config fields', async () => {
    const s = draftSprint('A', 'a');
    const sprintRepo = new InMemorySprintRepository([s]);
    const configStore = new InMemoryConfigStore({
      ...CONFIG_DEFAULTS,
      aiProvider: 'claude',
      evaluationIterations: 3,
    });
    const uc = new SetCurrentSprintUseCase(sprintRepo, configStore);

    await uc.execute({ id: s.id });
    expect(configStore.current.aiProvider).toBe('claude');
    expect(configStore.current.evaluationIterations).toBe(3);
  });
});
