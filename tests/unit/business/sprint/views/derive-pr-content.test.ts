import { describe, expect, it } from 'vitest';
import { closingRefs, derivePrContent, renderWarningsSection } from '@src/business/sprint/views/pr-content.ts';
import {
  makeApprovedTicket,
  makeBlockedTask,
  makeDoneTaskWithWarning,
  makeDoneTask,
  makeDraftSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

describe('derivePrContent', () => {
  it('uses the sprint name as the title', () => {
    const sprint = makeDraftSprint({ name: 'kickoff' });
    const out = derivePrContent(sprint, []);
    expect(out.title).toBe('kickoff');
  });

  it('renders sprint name as H1 and ticket list when no done tasks exist', () => {
    const ticket = makeApprovedTicket({ title: 'login bug' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const out = derivePrContent(sprint, []);
    expect(out.body).toContain(`# ${sprint.name}`);
    expect(out.body).toContain('## Tickets');
    expect(out.body).toContain('- login bug');
    expect(out.body).not.toContain('## Tasks');
  });

  it('omits any ralphctl trailer / sprint-id footer — the PR body is harness-agnostic', () => {
    const sprint = makeDraftSprint({ tickets: [makeApprovedTicket({ title: 'a' })] });
    const out = derivePrContent(sprint, [makeDoneTask()]);
    expect(out.body).not.toContain('sprint id');
    expect(out.body).not.toContain('ralphctl');
    expect(out.body).not.toContain(String(sprint.id));
  });

  it('omits the Tickets section when the sprint has no tickets', () => {
    const sprint = makeDraftSprint();
    const out = derivePrContent(sprint, []);
    expect(out.body).not.toContain('## Tickets');
  });

  it('includes the Tasks section listing only done tasks', () => {
    const sprint = makeDraftSprint();
    const done = makeDoneTask();
    const todo = makeTodoTask({ name: 'still-pending' });
    const out = derivePrContent(sprint, [done, todo]);
    expect(out.body).toContain('## Tasks');
    expect(out.body).toContain(`- ${done.name}`);
    expect(out.body).not.toContain('still-pending');
  });

  it('includes the Related issues section with `Closes <ref>` bullets for each implemented ticket externalRef', () => {
    const first = makeApprovedTicket({ title: 'first', externalRef: '#123' });
    const second = makeApprovedTicket({ title: 'second', externalRef: '!456' });
    const sprint = makeDraftSprint({ tickets: [first, second] });
    const out = derivePrContent(sprint, [makeDoneTask({ ticketId: first.id }), makeDoneTask({ ticketId: second.id })]);
    expect(out.body).toContain('## Related issues');
    expect(out.body).toContain('- Closes #123');
    expect(out.body).toContain('- Closes !456');
  });

  it('omits the Related issues section when no ticket carries an externalRef', () => {
    const sprint = makeDraftSprint({
      tickets: [makeApprovedTicket({ title: 'plain' })],
    });
    const out = derivePrContent(sprint, []);
    expect(out.body).not.toContain('## Related issues');
  });

  it('dedupes repeated externalRefs across tickets', () => {
    const tickets = [
      makeApprovedTicket({ title: 'a', externalRef: '#123' }),
      makeApprovedTicket({ title: 'b', externalRef: '#123' }),
      makeApprovedTicket({ title: 'c', externalRef: '!456' }),
    ];
    const sprint = makeDraftSprint({ tickets });
    const out = derivePrContent(
      sprint,
      tickets.map((t) => makeDoneTask({ ticketId: t.id }))
    );
    // First-seen wins; the duplicate `- Closes #123` line must not appear twice.
    const hits = out.body.match(/- Closes #123/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(out.body).toContain('- Closes !456');
  });

  it('appends a `## Completed with warnings` section for a done task with a final-attempt warning', () => {
    const sprint = makeDraftSprint();
    const warned = makeDoneTaskWithWarning({
      name: 'flaky-task',
      warning: { kind: 'plateau', dimensions: ['C1', 'C2'] },
    });
    const out = derivePrContent(sprint, [warned]);
    expect(out.body).toContain('## Completed with warnings');
    expect(out.body).toContain('- flaky-task — evaluator plateaued on: C1, C2');
    // It still lists the task under the normal Tasks section.
    expect(out.body).toContain('## Tasks');
    expect(out.body).toContain('- flaky-task');
  });

  it('omits the warnings section entirely when every done task landed clean (no empty header)', () => {
    const sprint = makeDraftSprint();
    const out = derivePrContent(sprint, [makeDoneTask({ name: 'clean' })]);
    expect(out.body).not.toContain('## Completed with warnings');
  });

  it('renderWarningsSection returns an empty string when no task is flagged', () => {
    expect(renderWarningsSection([makeDoneTask(), makeTodoTask()])).toBe('');
  });

  it('renderWarningsSection surfaces budget-exhausted with the turn counts', () => {
    const warned = makeDoneTaskWithWarning({
      name: 'budgeted',
      warning: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
    });
    const section = renderWarningsSection([warned]);
    expect(section).toContain('## Completed with warnings');
    expect(section).toContain('- budgeted — turn budget exhausted (5/5 turns)');
  });

  it('folds in Task.externalRefs[] alongside ticket refs, deduped first-seen-wins', () => {
    const sprint = makeDraftSprint({
      tickets: [makeApprovedTicket({ title: 'a', externalRef: '#123' })],
    });
    // Task carries the same ref as the ticket (planned 1:1 from it) plus an extra ref
    // a multi-ticket fan-in might surface later.
    const task = makeDoneTask({ externalRefs: ['#123', '#999'] });
    const out = derivePrContent(sprint, [task]);
    expect(out.body).toContain('## Related issues');
    // Single occurrence of the shared ref; ticket order first.
    const sharedHits = out.body.match(/- Closes #123/g) ?? [];
    expect(sharedHits).toHaveLength(1);
    expect(out.body).toContain('- Closes #999');
  });
});

describe('closingRefs', () => {
  it('closes a ref only when every task carrying it — directly or through its ticket — is done', () => {
    const shipped = makeApprovedTicket({ title: 'shipped', externalRef: '#1' });
    const stalled = makeApprovedTicket({ title: 'stalled', externalRef: '#2' });
    const partial = makeApprovedTicket({ title: 'partial', externalRef: '#3' });
    const unplanned = makeApprovedTicket({ title: 'unplanned', externalRef: '#4' });
    const sprint = makeDraftSprint({ tickets: [shipped, stalled, partial, unplanned] });
    const tasks = [
      makeDoneTask({ ticketId: shipped.id, externalRefs: ['#1'] }),
      makeBlockedTask({ ticketId: stalled.id, externalRefs: ['#2'] }),
      makeDoneTask({ ticketId: partial.id, externalRefs: ['#3'] }),
      makeBlockedTask({ ticketId: partial.id, externalRefs: ['#3'] }),
      makeDoneTask({ externalRefs: ['#5'] }),
      makeBlockedTask({ externalRefs: ['#6'] }),
    ];
    expect(closingRefs(sprint, tasks)).toEqual(['#1', '#5']);
    const body = derivePrContent(sprint, tasks).body;
    expect(body).toContain('- Closes #1');
    expect(body).toContain('- Closes #5');
    for (const ref of ['#2', '#3', '#4', '#6']) expect(body).not.toContain(`Closes ${ref}`);
  });
});
