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
 * Sentence for a failed `currentSprintStatus` gate. Prefers the manifest's own
 * `currentSprintStatusHint`; falls back to a generated sentence naming the allowed statuses so a
 * flow that never bothered to declare a hint (or declares one that later goes stale) still gets a
 * usable, if generic, message instead of nothing.
 */
const sprintStatusReason = (triggers: FlowTriggers, current: SprintStatus): string => {
  if (triggers.currentSprintStatusHint !== undefined) return triggers.currentSprintStatusHint;
  const allowed = triggers.currentSprintStatus ?? [];
  return `Sprint must be ${allowed.join(' or ')} to run this flow (currently ${current}).`;
};

/** One precondition check + the sentence to show when it fails. */
interface Gate {
  readonly failed: boolean;
  readonly reason: () => string;
}

/**
 * Evaluate a flow's {@link FlowTriggers} against the current {@link TriggerInputs}. Every
 * declared trigger must match; a missing field on `triggers` is a "don't care." The returned
 * `reason` is a single human-readable sentence — the TUI surfaces it as the disabled menu
 * item's tooltip / hint. Gates are checked in declaration order below so the first failing gate
 * wins, mirroring the field declaration order on {@link FlowTriggers}.
 */
export const evaluateTriggers = (triggers: FlowTriggers, inputs: TriggerInputs): TriggerEvaluation => {
  const gates: readonly Gate[] = [
    {
      failed: triggers.requiresProject === true && !inputs.hasProject,
      reason: () => 'Select a project first — use P to pick one or create one from Projects.',
    },
    {
      // No sprint at all — tell the user to create one.
      failed: triggers.currentSprintStatus !== undefined && inputs.currentSprintStatus === undefined,
      reason: () => 'No sprint selected — create or pick one from Sprints.',
    },
    {
      // Sprint exists but its status does not satisfy this flow's gate.
      failed:
        triggers.currentSprintStatus !== undefined &&
        inputs.currentSprintStatus !== undefined &&
        !triggers.currentSprintStatus.includes(inputs.currentSprintStatus),
      reason: () => sprintStatusReason(triggers, inputs.currentSprintStatus as SprintStatus),
    },
    {
      failed: triggers.minPendingTickets !== undefined && inputs.pendingTicketCount < triggers.minPendingTickets,
      reason: () =>
        inputs.pendingTicketCount === 0
          ? 'Add at least one ticket to the sprint before refining.'
          : `Add more tickets — need ${String(triggers.minPendingTickets)}, have ${String(inputs.pendingTicketCount)}.`,
    },
    {
      failed: triggers.minApprovedTickets !== undefined && inputs.approvedTicketCount < triggers.minApprovedTickets,
      reason: () =>
        inputs.approvedTicketCount === 0
          ? 'Refine and approve your tickets first — planning requires at least one approved ticket.'
          : `Approve more tickets — need ${String(triggers.minApprovedTickets)}, have ${String(inputs.approvedTicketCount)}.`,
    },
    {
      failed: triggers.minResumableTasks !== undefined && inputs.resumableTaskCount < triggers.minResumableTasks,
      reason: () => 'No tasks to implement — run Plan first to generate a task list for this sprint.',
    },
  ];

  const firstFailure = gates.find((gate) => gate.failed);
  return firstFailure === undefined ? { enabled: true } : { enabled: false, reason: firstFailure.reason() };
};
