import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { EditSprintUseCase } from './edit-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;
const T2 = '2026-04-29T16:00:00.000Z' as IsoTimestamp;

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

function draftSprint(): Sprint {
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('EditSprintUseCase', () => {
  it('renames a draft sprint and persists', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new EditSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, name: 'Renamed' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Renamed');

    const reread = await repo.findById(s.id);
    if (!reread.ok) throw new Error('expected sprint');
    expect(reread.value.name).toBe('Renamed');
  });

  it('updates the branch independently of the name', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new EditSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, branch: 'feature/x' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('A');
    expect(result.value.branch).toBe('feature/x');
  });

  it('clears the branch when null is passed', async () => {
    const s = draftSprint();
    const set = s.setBranch('feature/old');
    if (!set.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([set.value]);
    const uc = new EditSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, branch: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBeNull();
  });

  it('updates name and branch together', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new EditSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, name: 'Both', branch: 'feature/y' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Both');
    expect(result.value.branch).toBe('feature/y');
  });

  it('returns NotFoundError when the sprint id is unknown', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new EditSprintUseCase(repo);
    const result = await uc.execute({
      id: SprintId.trustString('20260101-000000-missing'),
      name: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns InvalidStateError when renaming a closed sprint', async () => {
    const s = draftSprint();
    const a = s.activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([c.value]);
    const uc = new EditSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, name: 'too late' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });

  it('returns ValidationError on empty name', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new EditSprintUseCase(repo);
    const result = await uc.execute({ id: s.id, name: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});
