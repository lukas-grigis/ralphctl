import { describe, expect, it } from 'vitest';
import { renderSprintRequirementsMarkdown } from '@src/business/sprint/views/requirements-md.ts';
import { makeApprovedTicket, makeDraftSprint, makePendingTicket, makePlannedSprint } from '@tests/fixtures/domain.ts';

describe('renderSprintRequirementsMarkdown', () => {
  it('renders header + only approved tickets', () => {
    const approved = makeApprovedTicket({ title: 'login bug', requirements: '## AC\n- a\n- b' });
    const pending = makePendingTicket({ title: 'logout bug' });
    const sprint = makeDraftSprint({ tickets: [approved, pending as never] });
    const out = renderSprintRequirementsMarkdown(sprint);
    expect(out).toContain(`# ${sprint.name} — Requirements`);
    expect(out).toContain('Approved tickets: 1 of 2');
    expect(out).toContain('## login bug');
    expect(out).toContain('- a');
    expect(out).not.toContain('## logout bug');
  });

  it('shows the empty-state hint when no approved tickets exist', () => {
    const sprint = makeDraftSprint();
    const out = renderSprintRequirementsMarkdown(sprint);
    expect(out).toContain('Approved tickets: 0 of 0');
    expect(out).toContain('run `ralphctl sprint refine` first');
  });

  it('includes ticket id and link when present', () => {
    const ticket = makeApprovedTicket({ title: 'with link' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const out = renderSprintRequirementsMarkdown(sprint);
    expect(out).toContain(`- ID: \`${String(ticket.id)}\``);
  });

  it('reflects sprint status (planned vs draft)', () => {
    const sprint = makePlannedSprint();
    const out = renderSprintRequirementsMarkdown(sprint);
    expect(out).toContain('Status: planned');
  });
});
