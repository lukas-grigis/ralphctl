import { describe, expect, it } from 'vitest';
import type { FlowTriggers } from '@src/application/registry.ts';
import { evaluateTriggers, type TriggerInputs } from '@src/application/registry-triggers.ts';
import { refineManifest } from '@src/application/flows/refine/manifest.ts';

const baseInputs: TriggerInputs = {
  hasProject: true,
  currentSprintStatus: undefined,
  pendingTicketCount: 0,
  approvedTicketCount: 0,
  resumableTaskCount: 0,
};

describe('evaluateTriggers', () => {
  it('returns enabled=true when no triggers are declared', () => {
    const result = evaluateTriggers({}, baseInputs);
    expect(result).toEqual({ enabled: true });
  });

  describe('requiresProject', () => {
    it('passes when a project is loaded', () => {
      const triggers: FlowTriggers = { requiresProject: true };
      expect(evaluateTriggers(triggers, { ...baseInputs, hasProject: true })).toEqual({ enabled: true });
    });

    it('fails with an action-oriented reason when no project is loaded', () => {
      const triggers: FlowTriggers = { requiresProject: true };
      const result = evaluateTriggers(triggers, { ...baseInputs, hasProject: false });
      expect(result.enabled).toBe(false);
      // Reason must tell the user what to do, not just state the failing condition.
      if (!result.enabled) {
        expect(result.reason).toMatch(/select a project|pick one/i);
      }
    });

    it('ignores hasProject when requiresProject is not set', () => {
      expect(evaluateTriggers({}, { ...baseInputs, hasProject: false })).toEqual({ enabled: true });
    });
  });

  describe('currentSprintStatus', () => {
    it('passes when the current status is in the allowed list', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'] };
      expect(evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'draft' })).toEqual({
        enabled: true,
      });
    });

    it('treats the allowed list as OR — any listed value passes', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['planned', 'active'] };
      expect(evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'planned' })).toEqual({
        enabled: true,
      });
      expect(evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'active' })).toEqual({
        enabled: true,
      });
    });

    it('fails with an action-oriented reason when the current status is not allowed', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'] };
      const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'active' });
      expect(result.enabled).toBe(false);
      // Reason must mention the relevant sprint state, not raw system names.
      if (!result.enabled) expect(result.reason).toMatch(/draft sprint/i);
    });

    it('fails with a "create or pick" reason when no sprint is loaded', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'] };
      const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: undefined });
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason).toMatch(/no sprint|create|pick/i);
    });
  });

  describe('minPendingTickets', () => {
    it('passes when count meets the minimum', () => {
      const triggers: FlowTriggers = { minPendingTickets: 2 };
      expect(evaluateTriggers(triggers, { ...baseInputs, pendingTicketCount: 2 })).toEqual({ enabled: true });
      expect(evaluateTriggers(triggers, { ...baseInputs, pendingTicketCount: 5 })).toEqual({ enabled: true });
    });

    it('fails with an action-oriented reason when count is below the minimum', () => {
      const triggers: FlowTriggers = { minPendingTickets: 1 };
      const result = evaluateTriggers(triggers, { ...baseInputs, pendingTicketCount: 0 });
      expect(result.enabled).toBe(false);
      // Reason should direct the user to add a ticket.
      if (!result.enabled) expect(result.reason).toMatch(/add.*ticket|ticket.*add/i);
    });
  });

  describe('minApprovedTickets', () => {
    it('passes when count meets the minimum', () => {
      const triggers: FlowTriggers = { minApprovedTickets: 1 };
      expect(evaluateTriggers(triggers, { ...baseInputs, approvedTicketCount: 1 })).toEqual({ enabled: true });
    });

    it('fails with an action-oriented reason when count is below the minimum', () => {
      const triggers: FlowTriggers = { minApprovedTickets: 3 };
      const result = evaluateTriggers(triggers, { ...baseInputs, approvedTicketCount: 1 });
      expect(result.enabled).toBe(false);
      // Reason should direct the user to approve more tickets (counts shown for non-zero case).
      if (!result.enabled) {
        expect(result.reason).toMatch(/approve.*ticket|ticket.*approv/i);
        expect(result.reason).toContain('3');
        expect(result.reason).toContain('1');
      }
    });
  });

  describe('minResumableTasks', () => {
    it('passes when count meets the minimum', () => {
      const triggers: FlowTriggers = { minResumableTasks: 1 };
      expect(evaluateTriggers(triggers, { ...baseInputs, resumableTaskCount: 4 })).toEqual({ enabled: true });
    });

    it('fails with an action-oriented reason when count is below the minimum', () => {
      const triggers: FlowTriggers = { minResumableTasks: 1 };
      const result = evaluateTriggers(triggers, { ...baseInputs, resumableTaskCount: 0 });
      expect(result.enabled).toBe(false);
      // Reason should direct the user to run Plan first.
      if (!result.enabled) expect(result.reason).toMatch(/plan|task list/i);
    });

    it('counts in_progress tasks too — Implement stays available for the resume case', () => {
      // The regression: after a crash mid-loop the sprint has 0 todo + 1 in_progress. The
      // launcher would accept that input (its filter is todo OR in_progress). The trigger
      // must agree or the menu grays out and the user can't relaunch.
      const triggers: FlowTriggers = { minResumableTasks: 1 };
      expect(evaluateTriggers(triggers, { ...baseInputs, resumableTaskCount: 1 })).toEqual({ enabled: true });
    });
  });

  describe('combinations', () => {
    it('passes only when every declared trigger matches', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'], minPendingTickets: 1 };
      expect(
        evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'draft', pendingTicketCount: 1 })
      ).toEqual({ enabled: true });
    });

    it('fails on the first unmet trigger (status before pending count)', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'], minPendingTickets: 1 };
      const result = evaluateTriggers(triggers, {
        ...baseInputs,
        currentSprintStatus: 'active',
        pendingTicketCount: 0,
      });
      expect(result.enabled).toBe(false);
      // Status gate fires first — reason should mention draft sprints, not pending tickets.
      if (!result.enabled) expect(result.reason).toMatch(/draft sprint/i);
    });

    it('fails on a later trigger when earlier triggers pass', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'], minPendingTickets: 1 };
      const result = evaluateTriggers(triggers, {
        ...baseInputs,
        currentSprintStatus: 'draft',
        pendingTicketCount: 0,
      });
      expect(result.enabled).toBe(false);
      // Status gate passes; pending-ticket gate fires — reason should mention adding tickets.
      if (!result.enabled) expect(result.reason).toMatch(/ticket|add/i);
    });

    it('handles the implement-style combo (status OR + minResumableTasks)', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['planned', 'active'], minResumableTasks: 1 };
      expect(
        evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'active', resumableTaskCount: 5 })
      ).toEqual({
        enabled: true,
      });
      const failed = evaluateTriggers(triggers, {
        ...baseInputs,
        currentSprintStatus: 'active',
        resumableTaskCount: 0,
      });
      expect(failed.enabled).toBe(false);
    });

    it('gives a "Plan this sprint first" hint when implement is tried on a draft sprint', () => {
      // The most common precondition mistake: user tries Implement on a freshly created sprint.
      const triggers: FlowTriggers = { currentSprintStatus: ['planned', 'active'], minResumableTasks: 1 };
      const result = evaluateTriggers(triggers, {
        ...baseInputs,
        currentSprintStatus: 'draft',
        resumableTaskCount: 0,
      });
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason).toMatch(/plan.*sprint|must be planned/i);
    });
  });
});

describe('refineManifest', () => {
  it('declares the new manifest fields per spec', () => {
    expect(refineManifest.canBackground).toBe(false);
    expect(refineManifest.triggers).toEqual({
      currentSprintStatus: ['draft'],
      minPendingTickets: 1,
    });
  });

  it('is enabled for a draft sprint with at least one pending ticket', () => {
    const result = evaluateTriggers(refineManifest.triggers, {
      ...baseInputs,
      currentSprintStatus: 'draft',
      pendingTicketCount: 1,
    });
    expect(result).toEqual({ enabled: true });
  });

  it('is disabled for a non-draft sprint', () => {
    const result = evaluateTriggers(refineManifest.triggers, {
      ...baseInputs,
      currentSprintStatus: 'active',
      pendingTicketCount: 5,
    });
    expect(result.enabled).toBe(false);
  });

  it('is disabled for a draft sprint with no pending tickets', () => {
    const result = evaluateTriggers(refineManifest.triggers, {
      ...baseInputs,
      currentSprintStatus: 'draft',
      pendingTicketCount: 0,
    });
    expect(result.enabled).toBe(false);
  });
});
