import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { AssignTicketRepositoriesUseCase } from './assign-ticket-repositories.ts';

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

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function draftWithTicket(): { sprint: Sprint; ticketId: TicketId } {
  const sprintR = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!sprintR.ok) throw new Error('precondition failed');
  const tidR = TicketId.parse('aaaaaaaa');
  if (!tidR.ok) throw new Error('precondition failed');
  const tR = Ticket.create({ id: tidR.value, title: 'old', projectName: projectName() });
  if (!tR.ok) throw new Error('precondition failed');
  const withTicket = sprintR.value.addTicket(tR.value);
  if (!withTicket.ok) throw new Error('precondition failed');
  return { sprint: withTicket.value, ticketId: tidR.value };
}

describe('AssignTicketRepositoriesUseCase', () => {
  it('persists the new repository list', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new AssignTicketRepositoriesUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      paths: [path('/abs/a'), path('/abs/b')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets[0]?.affectedRepositories).toEqual(['/abs/a', '/abs/b']);
  });

  it('overwrites a previous list (idempotent)', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new AssignTicketRepositoriesUseCase(repo);

    const first = await uc.execute({ sprintId: sprint.id, ticketId, paths: [path('/abs/a')] });
    if (!first.ok) throw new Error('precondition failed');

    const second = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      paths: [path('/abs/c')],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.tickets[0]?.affectedRepositories).toEqual(['/abs/c']);
  });

  it('returns NotFoundError when ticket id is unknown', async () => {
    const { sprint } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new AssignTicketRepositoriesUseCase(repo);

    const missing = TicketId.parse('bbbbbbbb');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId: missing.value,
      paths: [path('/abs/a')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
