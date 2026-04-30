import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { TicketId } from '../../../domain/values/ticket-id.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { ApproveTicketRequirementsUseCase } from './approve-ticket.ts';

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

describe('ApproveTicketRequirementsUseCase', () => {
  it('flips status to approved and stores requirements', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new ApproveTicketRequirementsUseCase(repo);

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId,
      requirements: 'must do X',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tickets[0]?.requirementStatus).toBe('approved');
    expect(result.value.tickets[0]?.requirements).toBe('must do X');
  });

  it('returns NotFoundError when ticket is unknown', async () => {
    const { sprint } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new ApproveTicketRequirementsUseCase(repo);

    const missing = TicketId.parse('bbbbbbbb');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({
      sprintId: sprint.id,
      ticketId: missing.value,
      requirements: 'r',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns InvalidStateError when re-approving an already-approved ticket', async () => {
    const { sprint, ticketId } = draftWithTicket();
    const repo = new InMemorySprintRepository([sprint]);
    const uc = new ApproveTicketRequirementsUseCase(repo);

    const first = await uc.execute({ sprintId: sprint.id, ticketId, requirements: 'first' });
    if (!first.ok) throw new Error('precondition failed');

    const second = await uc.execute({ sprintId: sprint.id, ticketId, requirements: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('invalid-state');
  });
});
