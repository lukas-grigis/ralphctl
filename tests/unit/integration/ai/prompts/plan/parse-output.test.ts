import { describe, expect, it } from 'vitest';
import { addTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import { approveTicketRequirements } from '@src/domain/entity/ticket.ts';
import { parsePlanOutput } from '@src/integration/ai/prompts/plan/parse-output.ts';
import { makeDraftSprint, makePendingTicket, makeProject } from '@tests/fixtures/domain.ts';

const project = makeProject();

const draftWith = (count: number): { sprint: Sprint; ticketIds: string[] } => {
  let sprint: Sprint = makeDraftSprint();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const pending = makePendingTicket({ title: `Ticket ${i + 1}` });
    const added = addTicket(sprint, pending);
    if (!added.ok) throw new Error('addTicket failed');
    const approved = approveTicketRequirements(added.value.tickets[i]!, '## reqs\n');
    if (!approved.ok) throw new Error('approve failed');
    sprint = {
      ...added.value,
      tickets: added.value.tickets.map((t, idx) => (idx === i ? approved.value : t)),
    };
    ids.push(String(approved.value.id));
  }
  return { sprint, ticketIds: ids };
};

describe('parsePlanOutput', () => {
  it('happy path: array of tasks → resolves repo + ticket, builds TodoTask[]', () => {
    const { sprint, ticketIds } = draftWith(2);
    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'A',
        ticketRef: ticketIds[0],
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
      {
        id: 'T2',
        name: 'B',
        ticketRef: ticketIds[1],
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        blockedBy: ['T1'],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toHaveLength(2);
    expect(out.value[0]?.name).toBe('A');
    expect(out.value[1]?.dependsOn).toHaveLength(1);
  });

  it('inherits the source ticket externalRef onto every task that references it', () => {
    // Seed two approved tickets — one with an external ref, one without — so we can verify
    // both inheritance and the "no ref → no externalRefs field" branch in a single plan.
    let sprint: Sprint = makeDraftSprint();
    const withRef = makePendingTicket({ title: 'tracked', externalRef: '#123' });
    const withoutRef = makePendingTicket({ title: 'untracked' });
    const a = addTicket(sprint, withRef);
    if (!a.ok) throw new Error('addTicket failed');
    const b = addTicket(a.value, withoutRef);
    if (!b.ok) throw new Error('addTicket failed');
    const approvedA = approveTicketRequirements(b.value.tickets[0]!, '## reqs\n');
    if (!approvedA.ok) throw new Error('approve failed');
    const approvedB = approveTicketRequirements(b.value.tickets[1]!, '## reqs\n');
    if (!approvedB.ok) throw new Error('approve failed');
    sprint = { ...b.value, tickets: [approvedA.value, approvedB.value] };

    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'tracked task',
        ticketRef: String(approvedA.value.id),
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
      {
        id: 'T2',
        name: 'untracked task',
        ticketRef: String(approvedB.value.id),
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value[0]?.externalRefs).toEqual(['#123']);
    // Tickets without an externalRef → task.externalRefs is undefined (not []), per the
    // minimal-persisted-shape rule.
    expect(out.value[1]?.externalRefs).toBeUndefined();
  });

  it('threads optional extraDimensions onto the resulting Task, lowercased and trimmed', () => {
    const { sprint, ticketIds } = draftWith(1);
    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'add a11y',
        ticketRef: ticketIds[0],
        projectPath: String(project.repositories[0]?.path),
        steps: ['add aria labels'],
        verificationCriteria: [{ id: 'C1', assertion: 'screen reader announces button', check: 'manual' }],
        extraDimensions: ['Accessibility', '  performance  '],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value[0]?.extraDimensions).toEqual(['accessibility', 'performance']);
  });

  it('rejects when AI emits {"blocked": "..."} — surfaces InvalidStateError', () => {
    const { sprint } = draftWith(1);
    const out = parsePlanOutput(JSON.stringify({ blocked: 'requirements unclear' }), {
      project,
      sprint,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.name).toBe('InvalidStateError');
      expect(out.error.message).toContain('requirements unclear');
    }
  });

  it('rejects malformed JSON', () => {
    const { sprint } = draftWith(1);
    const out = parsePlanOutput('{ not json', { project, sprint });
    expect(out.ok).toBe(false);
  });

  it('rejects an object that is neither array nor blocked', () => {
    const { sprint } = draftWith(1);
    const out = parsePlanOutput(JSON.stringify({ tasks: [] }), { project, sprint });
    expect(out.ok).toBe(false);
  });

  it('rejects when ticketRef is not in the sprint', () => {
    const { sprint } = draftWith(1);
    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'X',
        ticketRef: '00000000-0000-7000-8000-000000000000',
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain('not an approved ticket');
  });

  it('rejects when projectPath is not in the project repos', () => {
    const { sprint, ticketIds } = draftWith(1);
    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'X',
        ticketRef: ticketIds[0],
        projectPath: '/elsewhere',
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain('not in the project');
  });

  it('rejects when ticketRef is missing', () => {
    const { sprint } = draftWith(1);
    const json = JSON.stringify([
      {
        id: 'T1',
        name: 'X',
        projectPath: String(project.repositories[0]?.path),
        steps: ['s'],
        verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
      },
    ]);
    const out = parsePlanOutput(json, { project, sprint });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain('ticketRef missing');
  });
});
