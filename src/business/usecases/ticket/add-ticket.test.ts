import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { AddTicketUseCase } from './add-ticket.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;

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
  const r = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('AddTicketUseCase', () => {
  it('appends a ticket to a draft sprint', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new AddTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: s.id,
      ticketInput: { title: 'Login flow', projectName: projectName() },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets).toHaveLength(1);
    expect(result.value.tickets[0]?.title).toBe('Login flow');
  });

  it('returns ValidationError for an empty title', async () => {
    const s = draftSprint();
    const repo = new InMemorySprintRepository([s]);
    const uc = new AddTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: s.id,
      ticketInput: { title: '   ', projectName: projectName() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
    }
  });

  it('returns InvalidStateError when adding to a non-draft sprint', async () => {
    const s = draftSprint();
    const activated = s.activate(T1);
    if (!activated.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([activated.value]);
    const uc = new AddTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: s.id,
      ticketInput: { title: 't', projectName: projectName() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });

  it('returns NotFoundError when the sprint id is unknown', async () => {
    const repo = new InMemorySprintRepository();
    const uc = new AddTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: SprintId.trustString('20260101-000000-missing'),
      ticketInput: { title: 't', projectName: projectName() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns ConflictError on duplicate ticket id', async () => {
    const s = draftSprint();
    const tidR = TicketId.parse('aaaaaaaa');
    if (!tidR.ok) throw new Error('precondition failed');
    const t1 = Ticket.create({ id: tidR.value, title: 'first', projectName: projectName() });
    if (!t1.ok) throw new Error('precondition failed');
    const seeded = s.addTicket(t1.value);
    if (!seeded.ok) throw new Error('precondition failed');

    const repo = new InMemorySprintRepository([seeded.value]);
    const uc = new AddTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: s.id,
      ticketInput: { id: tidR.value, title: 'dup', projectName: projectName() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
  });
});
