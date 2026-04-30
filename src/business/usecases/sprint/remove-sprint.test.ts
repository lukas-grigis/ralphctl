import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { RemoveSprintUseCase } from './remove-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeSprint(): Sprint {
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('RemoveSprintUseCase', () => {
  it('removes a persisted sprint', async () => {
    const s = makeSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new RemoveSprintUseCase(repo);

    const result = await uc.execute({ id: s.id });
    expect(result.ok).toBe(true);

    const list = await repo.list();
    if (!list.ok) throw new Error('repo list failed');
    expect(list.value).toEqual([]);
  });

  it('returns NotFoundError for unknown id', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new RemoveSprintUseCase(repo);

    const result = await uc.execute({ id: SprintId.trustString('20260101-000000-missing') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
