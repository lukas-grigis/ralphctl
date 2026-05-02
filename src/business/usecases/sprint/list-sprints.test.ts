import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { ListSprintsUseCase } from './list-sprints.ts';

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

function sprint(name: string, slugStr: string): Sprint {
  const r = Sprint.create({ name, slug: slug(slugStr), now: T0, projectName: projectName() });
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
    expect(result.value).toStrictEqual([]);
  });

  it('returns every persisted sprint', async () => {
    const repo = new InMemorySprintRepository([sprint('A', 'a'), sprint('B', 'b')]);
    const uc = new ListSprintsUseCase(repo);

    const result = await uc.execute();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.map((s) => s.name).sort()).toStrictEqual(['A', 'B']);
  });
});
