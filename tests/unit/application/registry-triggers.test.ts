import { describe, expect, it } from 'vitest';
import { flowRegistry, type FlowTriggers } from '@src/application/registry.ts';
import { evaluateTriggers, type TriggerInputs } from '@src/application/registry-triggers.ts';
import { refineManifest } from '@src/application/flows/refine/manifest.ts';
import { reviewManifest } from '@src/application/flows/review/manifest.ts';
import { closeSprintManifest } from '@src/application/flows/close-sprint/manifest.ts';
import { createPrManifest } from '@src/application/flows/create-pr/manifest.ts';

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

    it('falls back to a generated sentence naming the allowed statuses when the manifest declares no hint', () => {
      // evaluateTriggers no longer reverse-engineers a flow's identity from the shape of the
      // allowed-status array — a bare trigger declaration with no `currentSprintStatusHint` gets
      // the generic, allowed-status-naming fallback rather than shape-sniffed copy.
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'] };
      const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'active' });
      expect(result.enabled).toBe(false);
      if (!result.enabled) {
        expect(result.reason).toMatch(/draft/i);
        expect(result.reason).toMatch(/active/i);
      }
    });

    it('prefers the manifest-supplied currentSprintStatusHint over the generated fallback', () => {
      const triggers: FlowTriggers = {
        currentSprintStatus: ['draft'],
        currentSprintStatusHint: 'Custom hint naming draft explicitly.',
      };
      const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: 'active' });
      expect(result).toEqual({ enabled: false, reason: 'Custom hint naming draft explicitly.' });
    });

    it('fails with a "create or pick" reason when no sprint is loaded', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['draft'] };
      const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: undefined });
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason).toMatch(/no sprint|create|pick/i);
    });

    it('characterizes the review-only gate (bare trigger, no hint): falls back to the generated sentence', () => {
      const triggers: FlowTriggers = { currentSprintStatus: ['review'] };
      for (const current of ['draft', 'planned', 'active', 'done'] as const) {
        const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: current });
        expect(result).toEqual({
          enabled: false,
          reason: `Sprint must be review to run this flow (currently ${current}).`,
        });
      }
    });

    it('characterizes the review-or-done gate (bare trigger, no hint): names both allowed statuses', () => {
      // This is the create-pr shape. Previously this hit the same shape-sniffed "review-status
      // sprint" copy as the review-only gate above (because `allowed[0] === 'review'`), which
      // wrongly implied `done` did not also satisfy it. The generated fallback now names every
      // allowed status instead of just the first.
      const triggers: FlowTriggers = { currentSprintStatus: ['review', 'done'] };
      for (const current of ['draft', 'planned', 'active'] as const) {
        const result = evaluateTriggers(triggers, { ...baseInputs, currentSprintStatus: current });
        expect(result).toEqual({
          enabled: false,
          reason: `Sprint must be review or done to run this flow (currently ${current}).`,
        });
      }
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
      // Status gate fires first — reason should mention the draft status, not pending tickets.
      if (!result.enabled) expect(result.reason).toMatch(/draft/i);
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

describe('review and close-sprint manifests', () => {
  it('both declare the same review-status hint', () => {
    expect(reviewManifest.triggers.currentSprintStatusHint).toBe(
      'Run Implement to completion first — this flow needs a review-status sprint.'
    );
    expect(closeSprintManifest.triggers.currentSprintStatusHint).toBe(reviewManifest.triggers.currentSprintStatusHint);
  });
});

describe('createPrManifest — the review-or-done correction', () => {
  it('no longer claims the sprint must specifically be review-status when done also passes', () => {
    // Before this fix, evaluateTriggers picked a message purely off `allowed[0] === 'review'`,
    // so create-pr (allowed: ['review', 'done']) got the exact same "needs a review-status
    // sprint" copy as the review-only flows — wrongly implying `done` did not also satisfy it.
    const result = evaluateTriggers(createPrManifest.triggers, { ...baseInputs, currentSprintStatus: 'active' });
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toMatch(/review/i);
      expect(result.reason).toMatch(/done/i);
      expect(result.reason).not.toBe(reviewManifest.triggers.currentSprintStatusHint);
    }
  });
});

describe('flowRegistry — every currentSprintStatus gate produces a usable reason', () => {
  const withSprintGate = flowRegistry
    .map((entry) => entry.manifest)
    .filter((manifest) => manifest.triggers.currentSprintStatus !== undefined);

  it('has at least one manifest under test with a currentSprintStatus gate', () => {
    expect(withSprintGate.length).toBeGreaterThan(0);
  });

  it.each(withSprintGate.map((manifest) => [manifest.id, manifest] as const))(
    '%s: disabled reason is non-empty and names every one of its allowed statuses',
    (_id, manifest) => {
      const allowed = manifest.triggers.currentSprintStatus ?? [];
      const disallowed = (['draft', 'planned', 'active', 'review', 'done'] as const).find(
        (status) => !allowed.includes(status)
      );
      // Every flow in the registry that gates on currentSprintStatus allows at least one status
      // it doesn't allow all five — otherwise the gate could never fail.
      if (disallowed === undefined) return;

      const inputs: TriggerInputs = {
        ...baseInputs,
        hasProject: true,
        currentSprintStatus: disallowed,
        pendingTicketCount: 999,
        approvedTicketCount: 999,
        resumableTaskCount: 999,
      };
      const result = evaluateTriggers(manifest.triggers, inputs);
      expect(result.enabled).toBe(false);
      if (!result.enabled) {
        expect(result.reason.length).toBeGreaterThan(0);
        for (const status of allowed) {
          expect(result.reason.toLowerCase()).toContain(status);
        }
      }
    }
  );
});
