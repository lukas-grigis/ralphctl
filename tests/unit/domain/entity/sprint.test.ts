import { describe, expect, it } from 'vitest';
import {
  activateSprint,
  createSprint,
  createSprintWithExecution,
  planSprint,
  renameSprint,
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

describe('createSprint', () => {
  it('produces a draft sprint with empty tickets and derived slug', () => {
    const r = createSprint({
      name: 'Sprint 1',

      projectId: FIXED_PROJECT_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('draft');
    expect(r.value.tickets).toEqual([]);
    expect(r.value.plannedAt).toBeNull();
    expect(r.value.reviewAt).toBeNull();
    expect(r.value.doneAt).toBeNull();
    expect(r.value.slug).toBe('sprint-1');
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sprint.status).toBe('draft');
    expect(r.value.execution.sprintId).toBe(r.value.sprint.id);
    expect(r.value.execution.setupRanAt).toEqual([]);
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('planned');
    expect(r.value.plannedAt).toBe(FIXED_LATER);
  });
});

describe('transitionSprintToReview', () => {
  it('transitions active → review and stamps reviewAt', () => {
    const r = transitionSprintToReview(makeActiveSprint(), FIXED_LATEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('review');
    expect(r.value.reviewAt).toBe(FIXED_LATEST);
    expect(r.value.doneAt).toBeNull();
  });

  it('rejects from non-active states', () => {
    expect(transitionSprintToReview(makeDraftSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makePlannedSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makeReviewSprint(), FIXED_LATEST).ok).toBe(false);
    expect(transitionSprintToReview(makeDoneSprint(), FIXED_LATEST).ok).toBe(false);
  });
});

describe('transitionSprintToDone', () => {
  it('transitions review → done and stamps doneAt', () => {
    const r = transitionSprintToDone(makeReviewSprint(), FIXED_LATEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('done');
    expect(r.value.doneAt).toBe(FIXED_LATEST);
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.slug).toBe('alt-handle');
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
    { from: 'review', sprint: () => makeReviewSprint(), allowed: ['transition-to-done', 'rename'] },
    { from: 'done', sprint: () => makeDoneSprint(), allowed: [] },
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
    it(`from ${c.from}: rename ${c.allowed.includes('rename') ? '✓' : '✗'}`, () => {
      const r = renameSprint(c.sprint(), 'new-name');
      expect(r.ok).toBe(c.allowed.includes('rename'));
    });
  }
});
