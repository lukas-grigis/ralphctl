import { describe, expect, it } from 'vitest';

import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { CreateSprintUseCase } from './create-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('CreateSprintUseCase', () => {
  it('creates a draft sprint and persists it', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new CreateSprintUseCase(repo);

    const result = await uc.execute({ name: 'My Sprint', slug: slug('my-sprint'), now: T0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('draft');
    expect(result.value.name).toBe('My Sprint');

    const list = await repo.list();
    if (!list.ok) throw new Error('repo list failed');
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.id).toBe(result.value.id);
  });

  it('returns ValidationError for an empty name', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new CreateSprintUseCase(repo);

    const result = await uc.execute({ name: '   ', slug: slug('x'), now: T0 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      if (result.error.code === 'invalid-value') {
        expect(result.error.field).toBe('sprint.name');
      }
    }
  });

  it('does not persist when validation fails', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new CreateSprintUseCase(repo);

    await uc.execute({ name: '', slug: slug('x'), now: T0 });

    const list = await repo.list();
    if (!list.ok) throw new Error('repo list failed');
    expect(list.value).toEqual([]);
  });
});
