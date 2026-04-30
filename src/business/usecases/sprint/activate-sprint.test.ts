import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { ActivateSprintUseCase } from './activate-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function draftSprint(): Sprint {
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('ActivateSprintUseCase', () => {
  it('activates a draft sprint and persists it', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new ActivateSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, now: T1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.activatedAt).toBe(T1);

    const reread = await repo.findById(s.id);
    if (!reread.ok) throw new Error('expected sprint after save');
    expect(reread.value.status).toBe('active');
  });

  it('returns NotFoundError when the sprint id is unknown', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new ActivateSprintUseCase(repo);

    const result = await uc.execute({
      id: SprintId.trustString('20260101-000000-missing'),
      now: T1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns InvalidStateError when activating a non-draft sprint', async () => {
    const s = draftSprint();
    const activatedR = s.activate(T1);
    if (!activatedR.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([activatedR.value]);
    const uc = new ActivateSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, now: T1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });
});
