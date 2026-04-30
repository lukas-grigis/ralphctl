import { describe, expect, it } from 'vitest';

import { InMemorySprintRepository } from '../../../business/_test-fakes/in-memory-sprint-repository.ts';
import { Sprint } from '../../../domain/entities/sprint.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { CONFIG_DEFAULTS } from '../../config/config-defaults.ts';
import type { Config } from '../../config/config.ts';
import type { ConfigStorePort } from '../../config/config-store-port.ts';
import { currentSprintReadableCheck } from './current-sprint-readable.ts';

class FakeConfigStore implements ConfigStorePort {
  constructor(private readonly cfg: Config) {}
  load(): Promise<Result<Config, StorageError>> {
    return Promise.resolve(Result.ok(this.cfg));
  }
  save(): Promise<Result<void, StorageError>> {
    return Promise.resolve(Result.ok());
  }
}

function makeSprint(): Sprint {
  const slug = Slug.parse('demo');
  if (!slug.ok) throw slug.error;
  const r = Sprint.create({
    name: 'Demo',
    slug: slug.value,
    now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
  });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('currentSprintReadableCheck', () => {
  it('returns skip when no current sprint is configured', async () => {
    const r = await currentSprintReadableCheck({
      configStore: new FakeConfigStore(CONFIG_DEFAULTS),
      sprintRepo: new InMemorySprintRepository(),
    });
    expect(r.status).toBe('skip');
    expect(r.message).toBe('no current sprint set');
  });

  it('returns pass when the configured sprint exists', async () => {
    const sprint = makeSprint();
    const r = await currentSprintReadableCheck({
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, currentSprint: sprint.id }),
      sprintRepo: new InMemorySprintRepository([sprint]),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('Demo');
    expect(r.message).toContain('draft');
  });

  it('returns fail when the configured sprint is missing', async () => {
    const sprintIdR = SprintId.parse('20260101-000000-ghost');
    if (!sprintIdR.ok) throw sprintIdR.error;
    const r = await currentSprintReadableCheck({
      configStore: new FakeConfigStore({ ...CONFIG_DEFAULTS, currentSprint: sprintIdR.value }),
      sprintRepo: new InMemorySprintRepository(),
    });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('20260101-000000-ghost');
  });
});
