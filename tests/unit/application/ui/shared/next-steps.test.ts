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
import { makeActiveSprint, makeDraftSprint, makePendingTicket, makeProject } from '@tests/fixtures/domain.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';

const base: NextStepsInput = {
  hasProject: true,
  projectCount: 1,
  sprintCount: 1,
  ticketCount: 0,
  pendingTicketCount: 0,
  approvedTicketCount: 0,
  resumableTaskCount: 0,
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
    '%s with nothing runnable points at the sprint, not at a no-op implement launch',
    (status) => {
      const { steps } = buildNextSteps(withSprint(status));
      expect(steps).toHaveLength(1);
      expect(steps[0]?.key).toBeUndefined();
      expect(steps[0]?.label).toContain('unblock');
      // The old Flows wording launched `implement` here, which would find nothing to do.
      expect(steps[0]?.label).not.toContain('implement');
    }
  );

  it('review offers BOTH visible flows — the single-string design could not express this', () => {
    const { steps } = buildNextSteps(withSprint('review'));
    expect(steps.map((s) => s.label)).toEqual(['run review', 'run close-sprint']);
    // Regression fence: Home used to advise create-pr here, which is hidden at `review`.
    expect(steps.map((s) => s.label)).not.toContain('run create-pr');
  });

  it('done recommends create-pr — Home used to say nothing at all here', () => {
    const { steps } = buildNextSteps(withSprint('done'));
    expect(steps[0]).toMatchObject({ key: 'n', label: 'run create-pr' });
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
});
