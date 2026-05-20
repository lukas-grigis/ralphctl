import { describe, expect, it } from 'vitest';
import { derivePrContent } from '@src/business/sprint/views/pr-content.ts';
import { makeApprovedTicket, makeDoneTask, makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

describe('derivePrContent', () => {
  it('uses the sprint name as the title', () => {
    const sprint = makeDraftSprint({ name: 'kickoff' });
    const out = derivePrContent(sprint, []);
    expect(out.title).toBe('kickoff');
  });

  it('renders sprint name as H1, ticket list, and sprint id footer when no done tasks exist', () => {
    const ticket = makeApprovedTicket({ title: 'login bug' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const out = derivePrContent(sprint, []);
    expect(out.body).toContain(`# ${sprint.name}`);
    expect(out.body).toContain('## Tickets');
    expect(out.body).toContain('- login bug');
    expect(out.body).not.toContain('## Tasks');
    expect(out.body).toContain(`— sprint id: \`${String(sprint.id)}\``);
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

  it('includes the Related issues section listing each ticket externalRef', () => {
    const sprint = makeDraftSprint({
      tickets: [
        makeApprovedTicket({ title: 'first', externalRef: '#123' }),
        makeApprovedTicket({ title: 'second', externalRef: '!456' }),
      ],
    });
    const out = derivePrContent(sprint, []);
    expect(out.body).toContain('## Related issues');
    expect(out.body).toContain('- #123');
    expect(out.body).toContain('- !456');
  });

  it('omits the Related issues section when no ticket carries an externalRef', () => {
    const sprint = makeDraftSprint({
      tickets: [makeApprovedTicket({ title: 'plain' })],
    });
    const out = derivePrContent(sprint, []);
    expect(out.body).not.toContain('## Related issues');
  });

  it('dedupes repeated externalRefs across tickets', () => {
    const sprint = makeDraftSprint({
      tickets: [
        makeApprovedTicket({ title: 'a', externalRef: '#123' }),
        makeApprovedTicket({ title: 'b', externalRef: '#123' }),
        makeApprovedTicket({ title: 'c', externalRef: '!456' }),
      ],
    });
    const out = derivePrContent(sprint, []);
    // First-seen wins; the duplicate `- #123` line must not appear twice.
    const hits = out.body.match(/- #123/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(out.body).toContain('- !456');
  });
});
