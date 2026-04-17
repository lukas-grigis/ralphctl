import { describe, expect, it } from 'vitest';
import { computePipelineSnapshot } from './pipeline-phases.ts';
import type { MenuContext } from './menu-builder.ts';

function baseCtx(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    hasProjects: true,
    projectCount: 1,
    currentSprintId: null,
    currentSprintName: null,
    currentSprintStatus: null,
    ticketCount: 0,
    taskCount: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    pendingRequirements: 0,
    allRequirementsApproved: false,
    plannedTicketCount: 0,
    nextAction: null,
    aiProvider: null,
    ...overrides,
  };
}

describe('computePipelineSnapshot', () => {
  it('returns four phases in fixed order: refine, plan, execute, close', () => {
    const snap = computePipelineSnapshot(baseCtx());
    expect(snap.phases.map((p) => p.id)).toEqual(['refine', 'plan', 'execute', 'close']);
  });

  describe('Refine phase', () => {
    it('suggests Create Sprint when no sprint exists', () => {
      const snap = computePipelineSnapshot(baseCtx({ currentSprintId: null, hasProjects: true }));
      const refine = snap.phases[0];
      expect(refine?.status).toBe('pending');
      expect(refine?.action).toEqual({ group: 'sprint', sub: 'create', label: 'Create Sprint' });
      expect(snap.currentPhaseId).toBe('refine');
      expect(snap.nextStep).toEqual(refine?.action);
    });

    it('suggests Add Ticket when a draft sprint has no tickets', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          hasProjects: true,
          ticketCount: 0,
        })
      );
      expect(snap.phases[0]?.action).toEqual({ group: 'ticket', sub: 'add', label: 'Add Ticket' });
    });

    it('offers no action to add tickets until projects exist', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          hasProjects: false,
          ticketCount: 0,
        })
      );
      expect(snap.phases[0]?.action).toBeNull();
      expect(snap.phases[0]?.detail).toBe('add a project first');
    });

    it('marks itself active when some tickets still need refinement', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 4,
          pendingRequirements: 2,
          allRequirementsApproved: false,
        })
      );
      expect(snap.phases[0]?.status).toBe('active');
      expect(snap.phases[0]?.detail).toBe('2/4 tickets approved');
      expect(snap.phases[0]?.action?.sub).toBe('refine');
    });

    it('marks itself done when every ticket is approved', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 3,
          pendingRequirements: 0,
          allRequirementsApproved: true,
        })
      );
      expect(snap.phases[0]?.status).toBe('done');
      expect(snap.phases[0]?.action).toBeNull();
    });
  });

  describe('Plan phase', () => {
    it('stays pending while requirements are unapproved', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 2,
          pendingRequirements: 1,
          allRequirementsApproved: false,
        })
      );
      expect(snap.phases[1]?.status).toBe('pending');
      expect(snap.phases[1]?.action).toBeNull();
    });

    it('becomes active with a Plan Tasks action once all requirements are approved and no tasks exist', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 2,
          allRequirementsApproved: true,
          taskCount: 0,
        })
      );
      expect(snap.phases[1]?.status).toBe('active');
      expect(snap.phases[1]?.action).toEqual({ group: 'sprint', sub: 'plan', label: 'Plan Tasks' });
      expect(snap.currentPhaseId).toBe('plan');
    });

    it('offers Re-Plan when tasks exist but some tickets are still unplanned', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 3,
          allRequirementsApproved: true,
          taskCount: 5,
          plannedTicketCount: 2,
        })
      );
      expect(snap.phases[1]?.status).toBe('active');
      expect(snap.phases[1]?.action?.label).toBe('Re-Plan Tasks');
    });

    it('becomes done when all tickets are planned', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 3,
          allRequirementsApproved: true,
          taskCount: 10,
          plannedTicketCount: 3,
        })
      );
      expect(snap.phases[1]?.status).toBe('done');
      expect(snap.phases[1]?.action).toBeNull();
    });
  });

  describe('Execute phase', () => {
    it('is pending when there are no tasks yet', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 1,
          allRequirementsApproved: true,
        })
      );
      expect(snap.phases[2]?.status).toBe('pending');
      expect(snap.phases[2]?.action).toBeNull();
    });

    it('offers Start Sprint on a draft sprint with tasks ready', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 2,
          allRequirementsApproved: true,
          taskCount: 5,
          plannedTicketCount: 2,
        })
      );
      expect(snap.phases[2]?.status).toBe('active');
      expect(snap.phases[2]?.action?.label).toBe('Start Sprint');
      expect(snap.currentPhaseId).toBe('execute');
    });

    it('offers Continue Work on an active sprint with remaining tasks', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'active',
          ticketCount: 2,
          allRequirementsApproved: true,
          taskCount: 10,
          tasksDone: 4,
          tasksInProgress: 2,
          plannedTicketCount: 2,
        })
      );
      expect(snap.phases[2]?.status).toBe('active');
      expect(snap.phases[2]?.detail).toBe('4/10 done · 2 running');
      expect(snap.phases[2]?.action?.sub).toBe('start');
      expect(snap.phases[2]?.action?.label).toMatch(/Continue Work/);
    });

    it('is done when all tasks are done', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'active',
          ticketCount: 1,
          allRequirementsApproved: true,
          taskCount: 3,
          tasksDone: 3,
          plannedTicketCount: 1,
        })
      );
      expect(snap.phases[2]?.status).toBe('done');
      expect(snap.phases[2]?.action).toBeNull();
    });
  });

  describe('Close phase', () => {
    it('offers Close Sprint on an active sprint with all tasks done', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'active',
          ticketCount: 1,
          allRequirementsApproved: true,
          taskCount: 2,
          tasksDone: 2,
          plannedTicketCount: 1,
        })
      );
      expect(snap.phases[3]?.status).toBe('active');
      expect(snap.phases[3]?.action).toEqual({ group: 'sprint', sub: 'close', label: 'Close Sprint' });
      expect(snap.currentPhaseId).toBe('close');
      expect(snap.nextStep).toEqual(snap.phases[3]?.action);
    });

    it('is done on a closed sprint', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'closed',
          ticketCount: 1,
          allRequirementsApproved: true,
          taskCount: 2,
          tasksDone: 2,
          plannedTicketCount: 1,
        })
      );
      expect(snap.phases[3]?.status).toBe('done');
      expect(snap.currentPhaseId).toBeNull();
      // Closed sprint offers a quick-action to create the next sprint so the
      // user has a clear forward path instead of stalling.
      expect(snap.nextStep).toEqual({ group: 'sprint', sub: 'create', label: 'Start a new sprint' });
    });

    it('is pending on an active sprint with work remaining', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'active',
          ticketCount: 1,
          allRequirementsApproved: true,
          taskCount: 5,
          tasksDone: 1,
          plannedTicketCount: 1,
        })
      );
      expect(snap.phases[3]?.status).toBe('pending');
      expect(snap.phases[3]?.action).toBeNull();
    });
  });

  describe('nextStep selection', () => {
    it('points to the first non-done phase', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'draft',
          ticketCount: 2,
          allRequirementsApproved: true,
          taskCount: 0,
        })
      );
      // Refine done, Plan active
      expect(snap.currentPhaseId).toBe('plan');
      expect(snap.nextStep?.sub).toBe('plan');
    });

    it('points to "create sprint" when every phase is done (closed sprint)', () => {
      const snap = computePipelineSnapshot(
        baseCtx({
          currentSprintId: 'sprint-1',
          currentSprintStatus: 'closed',
          ticketCount: 1,
          allRequirementsApproved: true,
          taskCount: 1,
          tasksDone: 1,
          plannedTicketCount: 1,
        })
      );
      expect(snap.currentPhaseId).toBeNull();
      expect(snap.nextStep).toEqual({ group: 'sprint', sub: 'create', label: 'Start a new sprint' });
    });
  });
});
