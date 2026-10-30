import { describe, expect, it } from 'vitest';
import {
  activateSprint,
  attachTicketLink,
  createSprint,
  createSprintWithExecution,
  planSprint,
  renameSprint,
  reopenDoneSprint,
  replaceTicket,
  revertSprintToActive,
  setSprintSlug,
  type Sprint,
  transitionSprintToDone,
  transitionSprintToReview,
} from '@src/domain/entity/sprint.ts';
import {
  FIXED_LATER,
  FIXED_LATEST,
  FIXED_PROJECT_ID,
  makeActiveSprint,
  makeApprovedTicket,
  makeDoneSprint,
  makeDraftSprint,
  makePendingTicket,
  makePlannedSprint,
  makeReviewSprint,
  slug,
} from '@tests/fixtures/domain.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

describe('createSprint', () => {
  it('produces a draft sprint with empty tickets and derived slug', () => {
    const r = createSprint({
      name: 'Sprint 1',

      projectId: FIXED_PROJECT_ID,
    });
    const rValue = r.getOrThrow();
    expect(rValue.status).toBe('draft');
    expect(rValue.tickets).toEqual([]);
    expect(rValue.plannedAt).toBeNull();
    expect(rValue.reviewAt).toBeNull();
    expect(rValue.doneAt).toBeNull();
    expect(rValue.slug).toBe('sprint-1');
  });

  it('rejects empty name', () => {
    const r = createSprint({
      name: '   ',

      projectId: FIXED_PROJECT_ID,
    });
    expect(r.ok).toBe(false);
  });
});

describe('createSprintWithExecution', () => {
  it('produces sprint and execution paired by sprintId', () => {
    const r = createSprintWithExecution({
      name: 'paired',

      projectId: FIXED_PROJECT_ID,
    });
    const rValue = r.getOrThrow();
    expect(rValue.sprint.status).toBe('draft');
    expect(rValue.execution.sprintId).toBe(rValue.sprint.id);
    expect(rValue.execution.setupRanAt).toEqual([]);
  });
});

describe('planSprint', () => {
  it('rejects when no tickets', () => {
    const draft = makeDraftSprint();
    const r = planSprint(draft, FIXED_LATER);
    expect(r.ok).toBe(false);
  });

  it('rejects when any ticket is pending', () => {
    const draft = makeDraftSprint({ tickets: [makePendingTicket() as unknown as never] });
    const r = planSprint(draft, FIXED_LATER);
    expect(r.ok).toBe(false);
  });

  it('transitions draft → planned with all-approved tickets', () => {
    const draft = makeDraftSprint({ tickets: [makeApprovedTicket()] });
    const r = planSprint(draft, FIXED_LATER);
    const rValue = r.getOrThrow();
    expect(rValue.status).toBe('planned');
    expect(rValue.plannedAt).toBe(FIXED_LATER);
  });
});

describe('transitionSprintToReview', () => {
  it('transitions active → review and stamps reviewAt', () => {
    const r = transitionSprintToReview(makeActiveSprint(), FIXED_LATEST);
    const value = r.getOrThrow();
    expect(value.status).toBe('review');
    expect(value.reviewAt).toBe(FIXED_LATEST);
    expect(value.doneAt).toBeNull();
  });

  it('rejects from non-active states', () => {
    expect(transitionSprintToReview(makeDraftSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makePlannedSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makeReviewSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makeDoneSprint(), FIXED_LATEST).ok).toBe(false);
  });
});

describe('revertSprintToActive', () => {
  it('reopens review → active, clears reviewAt, and re-stamps activatedAt', () => {
    const r = revertSprintToActive(makeReviewSprint(), FIXED_LATEST);
    const rValue = r.getOrThrow();
    expect(rValue.status).toBe('active');
    expect(rValue.reviewAt).toBeNull();
    expect(rValue.doneAt).toBeNull();
    expect(rValue.activatedAt).toBe(FIXED_LATEST);
    expect(rValue.plannedAt).not.toBeNull();
  });

  it('rejects from any non-review state', () => {
    expect(revertSprintToActive(makeDraftSprint(), FIXED_LATEST).ok).toBe(false);
    expect(revertSprintToActive(makePlannedSprint(), FIXED_LATEST).ok).toBe(false);
    expect(revertSprintToActive(makeActiveSprint(), FIXED_LATEST).ok).toBe(false);
    expect(revertSprintToActive(makeDoneSprint(), FIXED_LATEST).ok).toBe(false);
  });
});

describe('reopenDoneSprint', () => {
  it('reopens done → review, clears doneAt, and re-stamps reviewAt', () => {
    const r = reopenDoneSprint(makeDoneSprint(), FIXED_LATEST);
    const rValue = r.getOrThrow();
    expect(rValue.status).toBe('review');
    expect(rValue.doneAt).toBeNull();
    expect(rValue.reviewAt).toBe(FIXED_LATEST);
    expect(rValue.activatedAt).not.toBeNull();
    expect(rValue.plannedAt).not.toBeNull();
  });

  it('re-arms the existing review → active step: chaining both lands the sprint back at active', () => {
    const reopened = reopenDoneSprint(makeDoneSprint(), FIXED_LATEST);
    const reopenedValue = reopened.getOrThrow();
    const reactivated = revertSprintToActive(reopenedValue, FIXED_LATEST);
    const reactivatedValue = reactivated.getOrThrow();
    expect(reactivatedValue.status).toBe('active');
    expect(reactivatedValue.reviewAt).toBeNull();
  });

  it('rejects from any non-done state', () => {
    expect(reopenDoneSprint(makeDraftSprint(), FIXED_LATEST).ok).toBe(false);
    expect(reopenDoneSprint(makePlannedSprint(), FIXED_LATEST).ok).toBe(false);
    expect(reopenDoneSprint(makeActiveSprint(), FIXED_LATEST).ok).toBe(false);
    expect(reopenDoneSprint(makeReviewSprint(), FIXED_LATEST).ok).toBe(false);
  });
});

describe('transitionSprintToDone', () => {
  it('transitions review → done and stamps doneAt', () => {
    const r = transitionSprintToDone(makeReviewSprint(), FIXED_LATEST);
    const value = r.getOrThrow();
    expect(value.status).toBe('done');
    expect(value.doneAt).toBe(FIXED_LATEST);
  });

  it('rejects from any non-review state, including active and done', () => {
    expect(transitionSprintToDone(makeActiveSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToDone(makeDraftSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToDone(makePlannedSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToDone(makeDoneSprint(), FIXED_LATEST).ok).toBe(false);
  });
});

describe('setSprintSlug', () => {
  it('replaces the slug on a draft sprint', () => {
    const r = setSprintSlug(makeDraftSprint(), slug('alt-handle'));
    const rValue = r.getOrThrow();
    expect(rValue.slug).toBe('alt-handle');
  });

  it('rejects done sprints', () => {
    const r = setSprintSlug(makeDoneSprint(), slug('alt-handle'));
    expect(r.ok).toBe(false);
  });
});

describe('Sprint state-machine matrix', () => {
  const cases: ReadonlyArray<{ from: string; sprint: () => Sprint; allowed: readonly string[] }> = [
    {
      from: 'draft',
      sprint: () => makeDraftSprint({ tickets: [makeApprovedTicket()] }),
      allowed: ['plan', 'rename'],
    },
    { from: 'planned', sprint: () => makePlannedSprint(), allowed: ['activate', 'rename'] },
    { from: 'active', sprint: () => makeActiveSprint(), allowed: ['transition-to-review', 'rename'] },
    { from: 'review', sprint: () => makeReviewSprint(), allowed: ['transition-to-done', 'revert-to-active', 'rename'] },
    { from: 'done', sprint: () => makeDoneSprint(), allowed: ['reopen-done'] },
  ];

  for (const c of cases) {
    it(`from ${c.from}: plan ${c.allowed.includes('plan') ? '✓' : '✗'}`, () => {
      const r = planSprint(c.sprint(), FIXED_LATER);
      expect(r.ok).toBe(c.allowed.includes('plan'));
    });
    it(`from ${c.from}: activate ${c.allowed.includes('activate') ? '✓' : '✗'}`, () => {
      const r = activateSprint(c.sprint(), FIXED_LATEST);
      expect(r.ok).toBe(c.allowed.includes('activate'));
    });
    it(`from ${c.from}: transition-to-review ${c.allowed.includes('transition-to-review') ? '✓' : '✗'}`, () => {
      const r = transitionSprintToReview(c.sprint(), FIXED_LATEST);
      expect(r.ok).toBe(c.allowed.includes('transition-to-review'));
    });
    it(`from ${c.from}: transition-to-done ${c.allowed.includes('transition-to-done') ? '✓' : '✗'}`, () => {
      const r = transitionSprintToDone(c.sprint(), FIXED_LATEST);
      expect(r.ok).toBe(c.allowed.includes('transition-to-done'));
    });
    it(`from ${c.from}: revert-to-active ${c.allowed.includes('revert-to-active') ? '✓' : '✗'}`, () => {
      const r = revertSprintToActive(c.sprint(), FIXED_LATEST);
      expect(r.ok).toBe(c.allowed.includes('revert-to-active'));
    });
    it(`from ${c.from}: reopen-done ${c.allowed.includes('reopen-done') ? '✓' : '✗'}`, () => {
      const r = reopenDoneSprint(c.sprint(), FIXED_LATEST);
      expect(r.ok).toBe(c.allowed.includes('reopen-done'));
    });
    it(`from ${c.from}: rename ${c.allowed.includes('rename') ? '✓' : '✗'}`, () => {
      const r = renameSprint(c.sprint(), 'new-name');
      expect(r.ok).toBe(c.allowed.includes('rename'));
    });
  }
});

describe('attachTicketLink', () => {
  const ISSUE_URL = 'https://github.com/foo/bar/issues/42';

  it('attaches the link on a non-draft sprint and derives externalRef when absent', () => {
    const ticket = makeApprovedTicket();
    const sprint = makeActiveSprint({ tickets: [ticket] });
    const r = attachTicketLink(sprint, ticket.id, ISSUE_URL);
    const value = r.getOrThrow();
    expect(value.status).toBe('active');
    expect(value.tickets[0]?.link).toBe(ISSUE_URL);
    expect(value.tickets[0]?.externalRef).toBe('#42');
  });

  it('preserves an existing externalRef when attaching a link', () => {
    const ticket = makeApprovedTicket({ externalRef: 'PROJ-7' });
    const sprint = makeActiveSprint({ tickets: [ticket] });
    const r = attachTicketLink(sprint, ticket.id, ISSUE_URL);
    const rValue = r.getOrThrow();
    expect(rValue.tickets[0]?.link).toBe(ISSUE_URL);
    expect(rValue.tickets[0]?.externalRef).toBe('PROJ-7');
  });

  it('returns NotFoundError when the ticket is missing', () => {
    const sprint = makeActiveSprint();
    const r = attachTicketLink(sprint, makeApprovedTicket().id, ISSUE_URL);
    expect(r.ok).toBe(false);
  });

  it('rejects a done sprint with InvalidStateError — done sprints are immutable', () => {
    const sprint = makeDoneSprint();
    const ticketId = sprint.tickets[0]?.id;
    if (ticketId === undefined) throw new Error('fixture done sprint has no ticket');
    const r = attachTicketLink(sprint, ticketId, ISSUE_URL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(InvalidStateError);
    expect(sprint.tickets[0]?.link).toBeUndefined();
  });

  it('leaves replaceTicket draft-only: an active sprint still rejects replaceTicket', () => {
    const ticket = makeApprovedTicket();
    const sprint = makeActiveSprint({ tickets: [ticket] });
    const replaced = replaceTicket(sprint, ticket.id, { ...ticket, title: 'renamed' });
    expect(replaced.ok).toBe(false);
    const attached = attachTicketLink(sprint, ticket.id, ISSUE_URL);
    expect(attached.ok).toBe(true);
  });
});
