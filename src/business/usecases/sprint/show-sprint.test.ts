import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { ShowSprintUseCase } from './show-sprint.ts';

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

describe('ShowSprintUseCase', () => {
  it('returns the sprint when found', async () => {
    const s = makeSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new ShowSprintUseCase(repo);

    const result = await uc.execute({ id: s.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(s.id);
  });

  it('returns NotFoundError for unknown id', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new ShowSprintUseCase(repo);

    const missing = SprintId.trustString('20260101-000000-missing');
    const result = await uc.execute({ id: missing });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      if (result.error.code === 'not-found') {
        expect(result.error.entity).toBe('sprint');
      }
    }
  });
});
