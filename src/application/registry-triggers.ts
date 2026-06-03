import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import type { FlowTriggers } from '@src/application/registry.ts';

/**
 * Snapshot of the session state that triggers can be evaluated against. Producing this
 * snapshot is the caller's responsibility — typically the TUI / CLI assembles it from the
 * loaded project + current sprint + ticket / task counts before rendering the menu.
 */
export interface TriggerInputs {
  readonly hasProject: boolean;
  readonly currentSprintStatus?: SprintStatus | undefined;
  readonly pendingTicketCount: number;
  readonly approvedTicketCount: number;
  /**
   * Count of tasks the implement chain can pick up: `todo` PLUS `in_progress`. The
   * launcher's filter accepts both (the resume path settles a leftover `running` attempt as
   * `aborted` and re-opens a fresh one), so the trigger gating Implement must count both.
   * Otherwise a sprint that crashed mid-loop with zero todo + one in_progress task grays
   * out the menu and blocks the user from resuming.
   */
  readonly resumableTaskCount: number;
}

/** Discriminated result of {@link evaluateTriggers}. */
export type TriggerEvaluation = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

/**
 * Evaluate a flow's {@link FlowTriggers} against the current {@link TriggerInputs}. Every
 * declared trigger must match; a missing field on `triggers` is a "don't care." The returned
 * `reason` is a single human-readable sentence — the TUI surfaces it as the disabled menu
 * item's tooltip / hint. Order of checks mirrors the field declaration order on
 * {@link FlowTriggers} so the most-specific failure message wins predictably.
 */
export const evaluateTriggers = (triggers: FlowTriggers, inputs: TriggerInputs): TriggerEvaluation => {
  if (triggers.requiresProject === true && !inputs.hasProject) {
    return { enabled: false, reason: 'Select a project first — use P to pick one or create one from Projects.' };
  }

  if (triggers.currentSprintStatus !== undefined) {
    const allowed = triggers.currentSprintStatus;
    const current = inputs.currentSprintStatus;
    if (current === undefined) {
      // No sprint at all — tell the user to create one.
      return { enabled: false, reason: 'No sprint selected — create or pick one from Sprints.' };
    }
    if (!allowed.includes(current)) {
      // Sprint exists but its status does not satisfy this flow's gate. Produce a specific hint
      // based on what the flow actually needs so the user knows exactly what to do next.
      const [first] = allowed;
      if (first === 'draft') {
        return { enabled: false, reason: `This flow only runs on draft sprints (sprint is ${current}).` };
      }
      if (allowed.includes('planned') && allowed.includes('active')) {
        // Implement-style gate: needs a planned or active sprint.
        return {
          enabled: false,
          reason:
            current === 'draft'
              ? 'Plan this sprint first — it must be planned (or active) before you can implement.'
              : `Implement runs on planned or active sprints (sprint is ${current}).`,
        };
      }
      if (first === 'review') {
        return {
          enabled: false,
          reason:
            current === 'active' || current === 'planned'
              ? 'Run Implement to completion first — this flow needs a review-status sprint.'
              : `This flow needs a review-status sprint (sprint is ${current}).`,
        };
      }
      // Generic fallback for multi-value allowed sets not covered above (e.g. create-pr).
      const readableAllowed = allowed.join(' or ');
      return { enabled: false, reason: `Sprint must be ${readableAllowed} to run this flow (currently ${current}).` };
    }
  }

  if (triggers.minPendingTickets !== undefined && inputs.pendingTicketCount < triggers.minPendingTickets) {
    return {
      enabled: false,
      reason:
        inputs.pendingTicketCount === 0
          ? 'Add at least one ticket to the sprint before refining.'
          : `Add more tickets — need ${String(triggers.minPendingTickets)}, have ${String(inputs.pendingTicketCount)}.`,
    };
  }

  if (triggers.minApprovedTickets !== undefined && inputs.approvedTicketCount < triggers.minApprovedTickets) {
    return {
      enabled: false,
      reason:
        inputs.approvedTicketCount === 0
          ? 'Refine and approve your tickets first — planning requires at least one approved ticket.'
          : `Approve more tickets — need ${String(triggers.minApprovedTickets)}, have ${String(inputs.approvedTicketCount)}.`,
    };
  }

  if (triggers.minResumableTasks !== undefined && inputs.resumableTaskCount < triggers.minResumableTasks) {
    return {
      enabled: false,
      reason: 'No tasks to implement — run Plan first to generate a task list for this sprint.',
    };
  }

  return { enabled: true };
};
