import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { RemoveSprintUseCase } from './remove-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeSprint(): Sprint {
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
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
    expect(list.value).toStrictEqual([]);
  });

  it('returns NotFoundError for unknown id', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new RemoveSprintUseCase(repo);

    const result = await uc.execute({ id: SprintId.trustString('20260101-000000-missing') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
