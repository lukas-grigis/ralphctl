import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { ListSprintsUseCase } from './list-sprints.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function sprint(name: string, slugStr: string): Sprint {
  const r = Sprint.create({ name, slug: slug(slugStr), now: T0 });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('ListSprintsUseCase', () => {
  it('returns an empty array when no sprints exist', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new ListSprintsUseCase(repo);

    const result = await uc.execute();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns every persisted sprint', async () => {
    const repo = new InMemorySprintRepository([sprint('A', 'a'), sprint('B', 'b')]);
    const uc = new ListSprintsUseCase(repo);

    const result = await uc.execute();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.map((s) => s.name).sort()).toEqual(['A', 'B']);
  });
});
