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
    return { enabled: false, reason: 'No project is loaded.' };
  }

  if (triggers.currentSprintStatus !== undefined) {
    const allowed = triggers.currentSprintStatus;
    const current = inputs.currentSprintStatus;
    if (current === undefined || !allowed.includes(current)) {
      const expected = allowed.join(', ');
      const actual = current ?? 'no sprint';
      return { enabled: false, reason: `Requires sprint status ${expected} (current: ${actual}).` };
    }
  }

  if (triggers.minPendingTickets !== undefined && inputs.pendingTicketCount < triggers.minPendingTickets) {
    return {
      enabled: false,
      reason: `Requires at least ${String(triggers.minPendingTickets)} pending ticket(s) (have ${String(inputs.pendingTicketCount)}).`,
    };
  }

  if (triggers.minApprovedTickets !== undefined && inputs.approvedTicketCount < triggers.minApprovedTickets) {
    return {
      enabled: false,
      reason: `Requires at least ${String(triggers.minApprovedTickets)} approved ticket(s) (have ${String(inputs.approvedTicketCount)}).`,
    };
  }

  if (triggers.minResumableTasks !== undefined && inputs.resumableTaskCount < triggers.minResumableTasks) {
    return {
      enabled: false,
      reason: `Requires at least ${String(triggers.minResumableTasks)} pending task(s) (have ${String(inputs.resumableTaskCount)}).`,
    };
  }

  return { enabled: true };
};
