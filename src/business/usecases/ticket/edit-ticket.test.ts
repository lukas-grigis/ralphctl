import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { EditTicketUseCase } from './edit-ticket.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(name = 'demo'): ProjectName {
  const r = ProjectName.parse(name);
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

describe('EditTicketUseCase', () => {
  it('updates the title and persists', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new EditTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      partial: { title: 'new title' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets[0]?.title).toBe('new title');
  });

  it('reassigns the projectName when supplied', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new EditTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      partial: { projectName: projectName('other-project') },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets[0]?.projectName).toBe('other-project');
  });

  it('returns NotFoundError when the ticket id is unknown', async () => {
    const { sprint } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new EditTicketUseCase(repo);

    const missing = TicketId.parse('bbbbbbbb');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId: missing.value,
      partial: { title: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      if (result.error.code === 'not-found') {
        expect(result.error.entity).toBe('ticket');
      }
    }
  });

  it('returns ValidationError when the new title is empty', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new EditTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      partial: { title: '   ' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns InvalidStateError when sprint is not draft', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const activated = sprint.activate(T1);
    if (!activated.ok) throw new Error('precondition failed');
    const repo = new InMemorySprintRepository([activated.value]);
    const uc = new EditTicketUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      partial: { title: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });
});
