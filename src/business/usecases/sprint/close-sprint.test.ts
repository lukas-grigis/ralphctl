import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { CloseSprintUseCase } from './close-sprint.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;
const T2 = '2026-04-29T16:00:00.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function activeSprint(): Sprint {
  const draft = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!draft.ok) throw new Error('precondition failed');
  const a = draft.value.activate(T1);
  if (!a.ok) throw new Error('precondition failed');
  return a.value;
}

describe('CloseSprintUseCase', () => {
  it('closes an active sprint and persists it', async () => {
    const s = activeSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new CloseSprintUseCase(repo);

    const result = await uc.execute({ id: s.id, now: T2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('closed');
    expect(result.value.closedAt).toBe(T2);
  });

  it('returns InvalidStateError when closing a draft', async () => {
    const draft = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
    if (!draft.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([draft.value]);
    const uc = new CloseSprintUseCase(repo);

    const result = await uc.execute({ id: draft.value.id, now: T2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });

  it('returns NotFoundError when the sprint id is unknown', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new CloseSprintUseCase(repo);

    const result = await uc.execute({
      id: SprintId.trustString('20260101-000000-missing'),
      now: T2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
