/**
 * `buildNextSteps` is the single source of "given where this run / sprint ended up, what should
 * the operator do next". Three surfaces read it (the settled ResultCard, Home's state card, the
 * Flows orientation card), so the table below is the contract all three inherit.
 *
 * The load-bearing assertion is the visibility fence: every flow name a step recommends must be
 * in `visibleFlowsFor` for that sprint status. Home used to advise `create-pr` at `review`, a
 * flow the Flows menu hides in that state — that class of bug cannot come back while this holds.
 */

import { describe, expect, it } from 'vitest';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import type { NextStepsInput } from '@src/application/ui/shared/next-steps.ts';
import { visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import {
  makeActiveSprint,
  makeDraftSprint,
  makePendingTicket,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';

const base: NextStepsInput = {
  hasProject: true,
  projectCount: 1,
  sprintCount: 1,
  ticketCount: 0,
  pendingTicketCount: 0,
  approvedTicketCount: 0,
  resumableTaskCount: 0,
  blockedTaskCount: 0,
  upstreamBlockedTaskCount: 0,
};

const withSprint = (status: SprintStatus, over: Partial<NextStepsInput> = {}): NextStepsInput => ({
  ...base,
  sprintStatus: status,
  ...over,
});

/** Flow names a step label may embed — `run <flow>` is the only shape that names one. */
const flowNameOf = (label: string): string | undefined => {
  const m = /^run ([a-z-]+)$/.exec(label);
  return m?.[1];
};

/** A fresh `blocked` task of the given kind, for exercising the real task-status wiring. */
const blockedTask = (blockKind: 'own' | 'upstream'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), 'stuck', blockKind);
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

describe('buildNextSteps — sprint-state rows', () => {
  it('draft with no tickets tells the operator to add one, keylessly (the chord is view-local)', () => {
    const { steps } = buildNextSteps(withSprint('draft'));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe('add a ticket');
    expect(steps[0]?.key).toBeUndefined();
  });

  it('draft with pending tickets recommends refine and counts them', () => {
    const { steps } = buildNextSteps(withSprint('draft', { ticketCount: 3, pendingTicketCount: 2 }));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run refine' });
    expect(steps[0]?.detail).toContain('2');
  });

  it('draft with only approved tickets recommends plan', () => {
    const { steps } = buildNextSteps(withSprint('draft', { ticketCount: 2, approvedTicketCount: 2 }));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run plan' });
    expect(steps[0]?.detail).toContain('2');
  });

  it('draft with tickets that are neither pending nor approved falls back to refine', () => {
    const { steps } = buildNextSteps(withSprint('draft', { ticketCount: 1 }));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run refine' });
  });

  it.each<SprintStatus>(['planned', 'active'])('%s with resumable tasks recommends implement', (status) => {
    const { steps } = buildNextSteps(withSprint(status, { resumableTaskCount: 4 }));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run implement' });
    expect(steps[0]?.detail).toContain('4');
  });

  it.each<SprintStatus>(['planned', 'active'])(
    '%s with nothing runnable AND nothing blocked points at the sprint, not at a no-op implement launch',
    (status) => {
      const { steps } = buildNextSteps(withSprint(status));
      expect(steps).toHaveLength(1);
      expect(steps[0]?.key).toBeUndefined();
      expect(steps[0]?.label).toContain('unblock');
      // The old Flows wording launched `implement` here, which would find nothing to do.
      expect(steps[0]?.label).not.toContain('implement');
    }
  );

  it.each<SprintStatus>(['planned', 'active'])(
    '%s with EVERY remaining task blocked names the count instead of "0 tasks pending"',
    (status) => {
      // The bug this fixes: resumableTaskCount === 0 used to read as "nothing pending" even
      // when the sprint had 3 tasks stuck — this is that exact shape.
      const { steps } = buildNextSteps(withSprint(status, { blockedTaskCount: 3, upstreamBlockedTaskCount: 0 }));
      expect(steps).toHaveLength(1);
      expect(steps[0]?.key).toBeUndefined();
      expect(steps[0]?.label).toBe('unblock 3 blocked tasks');
      expect(steps[0]?.detail).toBe('open the sprint and press u');
    }
  );

  it.each<SprintStatus>(['planned', 'active'])(
    '%s with SOME resumable AND some blocked shows both, blocked first',
    (status) => {
      const { steps } = buildNextSteps(
        withSprint(status, { resumableTaskCount: 2, blockedTaskCount: 1, upstreamBlockedTaskCount: 0 })
      );
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ label: 'unblock 1 blocked task' });
      expect(steps[0]?.key).toBeUndefined();
      expect(steps[1]).toMatchObject({ key: 'n', label: 'run implement' });
    }
  );

  it.each<SprintStatus>(['planned', 'active'])(
    '%s blocked-task detail distinguishes upstream-blocked (auto-clears) from own-blocked (needs a fix)',
    (status) => {
      // Entirely upstream-blocked: informational, no operator action implied.
      const allUpstream = buildNextSteps(withSprint(status, { blockedTaskCount: 2, upstreamBlockedTaskCount: 2 }))
        .steps[0];
      expect(allUpstream?.detail).toBe('2 tasks waiting on a prerequisite');

      // Mixed: names both subsets rather than collapsing them into one count.
      const mixed = buildNextSteps(withSprint(status, { blockedTaskCount: 3, upstreamBlockedTaskCount: 1 })).steps[0];
      expect(mixed?.detail).toBe('2 tasks to fix, 1 more upstream');

      // Singular edge: grammar must not slip ("1 task need..." would be wrong subject-verb
      // agreement) — the wording avoids a conjugated verb entirely so the count never breaks it.
      const singularMixed = buildNextSteps(withSprint(status, { blockedTaskCount: 2, upstreamBlockedTaskCount: 1 }))
        .steps[0];
      expect(singularMixed?.detail).toBe('1 task to fix, 1 more upstream');

      // Regression fence: `more` is an adverb, not a noun — running the upstream count through
      // the naive `plural` helper used to render "2 mores upstream" for any count !== 1.
      const pluralUpstream = buildNextSteps(withSprint(status, { blockedTaskCount: 5, upstreamBlockedTaskCount: 2 }))
        .steps[0];
      expect(pluralUpstream?.detail).toBe('3 tasks to fix, 2 more upstream');
      expect(pluralUpstream?.detail).not.toContain('mores');
    }
  );

  it('review offers BOTH visible flows — the single-string design could not express this', () => {
    const { steps } = buildNextSteps(withSprint('review'));
    expect(steps.map((s) => s.label)).toEqual(['run review', 'run close-sprint']);
    // Regression fence: Home used to advise create-pr here, which is hidden at `review`.
    expect(steps.map((s) => s.label)).not.toContain('run create-pr');
  });

  it('review with blocked tasks leads with the unblock callout, then both flow rows', () => {
    const { steps } = buildNextSteps(withSprint('review', { blockedTaskCount: 2, upstreamBlockedTaskCount: 0 }));
    expect(steps.map((s) => s.label)).toEqual(['unblock 2 blocked tasks', 'run review', 'run close-sprint']);
    expect(steps[0]?.key).toBeUndefined();
  });

  it('done recommends create-pr — Home used to say nothing at all here', () => {
    const { steps } = buildNextSteps(withSprint('done'));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run create-pr' });
  });

  it('done with blocked tasks leads with the unblock callout naming the reopen path, then create-pr', () => {
    // The regression this fixes: closing a sprint with blocked tasks (confirm-and-proceed) used
    // to leave this table — the source every orientation surface reads from — silent about them,
    // even though unblocking one reopens the sprint rather than leaving it stuck forever.
    const { steps } = buildNextSteps(withSprint('done', { blockedTaskCount: 3, upstreamBlockedTaskCount: 0 }));
    expect(steps.map((s) => s.label)).toEqual(['unblock 3 blocked tasks', 'run create-pr']);
    expect(steps[0]?.key).toBeUndefined();
    expect(steps[0]?.detail).toBe('open the sprint and press u — u reopens the sprint');
  });

  it.each<SprintStatus>(['draft', 'planned', 'active', 'review', 'done'])(
    'every flow recommended at %s is visible in the Flows menu at that status',
    (status) => {
      const visible = visibleFlowsFor({ hasProject: true, sprintStatus: status, showAll: false });
      const inputs: readonly NextStepsInput[] = [
        withSprint(status),
        withSprint(status, { ticketCount: 2, pendingTicketCount: 2 }),
        withSprint(status, { ticketCount: 2, approvedTicketCount: 2 }),
        withSprint(status, { resumableTaskCount: 3 }),
        withSprint(status, { blockedTaskCount: 2, upstreamBlockedTaskCount: 1 }),
        withSprint(status, { resumableTaskCount: 3, blockedTaskCount: 2, upstreamBlockedTaskCount: 1 }),
      ];
      for (const input of inputs) {
        for (const step of buildNextSteps(input).steps) {
          const flow = flowNameOf(step.label);
          if (flow === undefined) continue;
          expect(visible.has(flow), `${status}: "${step.label}" names a flow hidden at that status`).toBe(true);
        }
      }
    }
  );
});

describe('buildNextSteps — pre-sprint rows', () => {
  it('no project anywhere in storage → create one, keylessly', () => {
    const { steps } = buildNextSteps({ ...base, hasProject: false, projectCount: 0, sprintCount: 0 });
    expect(steps[0]?.label).toBe('create a project');
    expect(steps[0]?.key).toBeUndefined();
  });

  it('projects exist but none picked → the global P chord', () => {
    const { steps } = buildNextSteps({ ...base, hasProject: false, projectCount: 3, sprintCount: 0 });
    expect(steps[0]).toMatchObject({ key: 'P', label: 'pick a project' });
    expect(steps[0]?.detail).toContain('3');
  });

  it('project loaded, no sprints yet → create the first one', () => {
    const { steps } = buildNextSteps({ ...base, sprintCount: 0 });
    expect(steps[0]).toMatchObject({ key: '+', label: 'create the first sprint' });
  });

  it('project loaded, sprints exist but none picked → the global S chord', () => {
    const { steps } = buildNextSteps({ ...base, sprintCount: 4 });
    expect(steps[0]).toMatchObject({ key: 'S', label: 'pick a sprint' });
    expect(steps[0]?.detail).toContain('4');
  });
});

describe('buildNextSteps — settled-run prepend', () => {
  it('a failed run leads with re-run and names the leaf that failed', () => {
    const { steps } = buildNextSteps({
      ...withSprint('review'),
      runStatus: 'failed',
      failedLeafLabel: 'generate patch',
    });
    expect(steps[0]).toMatchObject({ key: 'r', label: 're-run from Flows' });
    expect(steps[0]?.detail).toContain('generate patch');
    // The state rows still follow — a failed run does not erase where the sprint stands.
    expect(steps.map((s) => s.label)).toContain('run review');
  });

  it('an aborted run leads with re-run and says the sprint is unchanged', () => {
    const { steps } = buildNextSteps({ ...withSprint('draft'), runStatus: 'aborted' });
    expect(steps[0]).toMatchObject({ key: 'r', label: 're-run from Flows' });
    expect(steps[0]?.detail).toContain('unchanged');
  });

  it('a completed run prepends nothing — the state rows ARE the answer', () => {
    const { steps } = buildNextSteps({ ...withSprint('review'), runStatus: 'completed' });
    expect(steps.map((s) => s.key)).not.toContain('r');
    expect(steps[0]?.label).toBe('run review');
  });
});

describe('buildNextSteps — forensics passthrough', () => {
  it('echoes the caller-resolved paths without touching the filesystem', () => {
    const forensics = [{ label: 'progress.md', path: '/tmp/sprint/progress.md' }];
    expect(buildNextSteps({ ...withSprint('active'), forensics }).forensics).toEqual(forensics);
  });

  it('defaults to an empty list when the caller omits it', () => {
    expect(buildNextSteps(withSprint('active')).forensics).toEqual([]);
  });
});

describe('nextStepsInputFromSnapshot', () => {
  it('projects a loaded-sprint snapshot onto the flat input bag', () => {
    const draft = { ...makeDraftSprint(), tickets: [makePendingTicket({ title: 'x' })] } as unknown as Sprint;
    const snapshot = {
      project: makeProject({ displayName: 'Demo' }),
      sprint: draft,
      tasks: [],
      triggerInputs: {
        hasProject: true,
        currentSprintStatus: 'draft',
        pendingTicketCount: 1,
        approvedTicketCount: 0,
        resumableTaskCount: 0,
      },
      projectCount: 2,
      sprintCount: 5,
      recentSprints: [],
    } as unknown as AppStateSnapshot;

    expect(nextStepsInputFromSnapshot(snapshot)).toEqual({
      hasProject: true,
      projectCount: 2,
      sprintCount: 5,
      sprintStatus: 'draft',
      ticketCount: 1,
      pendingTicketCount: 1,
      approvedTicketCount: 0,
      resumableTaskCount: 0,
      blockedTaskCount: 0,
      upstreamBlockedTaskCount: 0,
    });
  });

  it('omits sprintStatus entirely when no sprint is loaded', () => {
    const snapshot = {
      project: makeProject({ displayName: 'Demo' }),
      tasks: [],
      triggerInputs: {
        hasProject: true,
        pendingTicketCount: 0,
        approvedTicketCount: 0,
        resumableTaskCount: 0,
      },
      projectCount: 1,
      sprintCount: 0,
      recentSprints: [],
    } as unknown as AppStateSnapshot;

    expect(nextStepsInputFromSnapshot(snapshot).sprintStatus).toBeUndefined();
    expect(buildNextSteps(nextStepsInputFromSnapshot(snapshot)).steps[0]?.label).toBe('create the first sprint');
  });

  it('round-trips an active snapshot into the implement recommendation', () => {
    const snapshot = {
      project: makeProject({ displayName: 'Demo' }),
      sprint: makeActiveSprint(),
      tasks: [],
      triggerInputs: {
        hasProject: true,
        currentSprintStatus: 'active',
        pendingTicketCount: 0,
        approvedTicketCount: 1,
        resumableTaskCount: 2,
      },
      projectCount: 1,
      sprintCount: 1,
      recentSprints: [],
    } as unknown as AppStateSnapshot;

    expect(buildNextSteps(nextStepsInputFromSnapshot(snapshot)).steps[0]).toMatchObject({
      key: 'n',
      label: 'run implement',
    });
  });

  it('derives blocked / upstream-blocked counts from real tasks on the snapshot, not just triggerInputs', () => {
    const snapshot = {
      project: makeProject({ displayName: 'Demo' }),
      sprint: makeActiveSprint(),
      tasks: [blockedTask('own'), blockedTask('own'), blockedTask('upstream'), makeTodoTask()],
      triggerInputs: {
        hasProject: true,
        currentSprintStatus: 'active',
        pendingTicketCount: 0,
        approvedTicketCount: 1,
        resumableTaskCount: 1,
      },
      projectCount: 1,
      sprintCount: 1,
      recentSprints: [],
    } as unknown as AppStateSnapshot;

    const input = nextStepsInputFromSnapshot(snapshot);
    expect(input.blockedTaskCount).toBe(3);
    expect(input.upstreamBlockedTaskCount).toBe(1);

    // And it reaches the rendered step: resumable AND blocked both show, blocked first.
    const { steps } = buildNextSteps(input);
    expect(steps[0]).toMatchObject({ label: 'unblock 3 blocked tasks' });
    expect(steps[1]).toMatchObject({ key: 'n', label: 'run implement' });
  });
});
