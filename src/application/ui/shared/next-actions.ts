/**
 * Suggest the next reasonable user action(s) given the current app-state snapshot. Pure: maps
 * snapshot → ordered hints. Consumed by Home so the user always sees what to do next without
 * having to memorise the flow order.
 *
 * Each `NextAction` carries a label, a one-line rationale, and a `route` that callers can
 * `router.push` directly. Keep the list ordered: callers may render only the top one as the
 * primary CTA and slot the rest as secondary chips.
 */

import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';

export interface NextAction {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** View entry to push. Home pushes it on `↵` / hotkey activation. */
  readonly route: ViewEntry;
}

export const suggestNextActions = (snapshot: AppStateSnapshot): readonly NextAction[] => {
  if (!snapshot.project) {
    return [
      {
        id: 'create-project',
        label: 'Create your first project',
        hint: 'Bind a repository to a project — nothing else can run without one.',
        route: { id: 'create-project' },
      },
    ];
  }

  // Project exists. If no sprint is selected, the user either has none or hasn't picked one.
  if (!snapshot.sprint) {
    return [
      {
        id: 'sprints',
        label: 'Pick or create a sprint',
        hint: 'Sprints are the unit of work — refine / plan / implement all run against one.',
        route: { id: 'sprints' },
      },
    ];
  }

  const sprint = snapshot.sprint;
  const { pendingTicketCount, approvedTicketCount, resumableTaskCount } = snapshot.triggerInputs;

  const actions: NextAction[] = [];

  // Draft sprints: drive the user through the refine → plan handoff.
  if (sprint.status === 'draft') {
    if (sprint.tickets.length === 0) {
      actions.push({
        id: 'open-sprint',
        label: 'Add tickets to the current sprint',
        hint: 'Open the sprint and press a — tickets live as inputs to refine.',
        route: { id: 'sprint-detail', props: { sprintId: sprint.id } },
      });
    }
    if (pendingTicketCount > 0) {
      actions.push({
        id: 'flows-refine',
        label: `Refine ${String(pendingTicketCount)} pending ticket(s)`,
        hint: 'Refine sharpens raw titles + descriptions into the contract that plan reads.',
        route: { id: 'flows' },
      });
    }
    if (approvedTicketCount > 0) {
      actions.push({
        id: 'flows-plan',
        label: `Plan ${String(approvedTicketCount)} approved ticket(s)`,
        hint: 'Plan transforms approved tickets into a dependency-ordered task list.',
        route: { id: 'flows' },
      });
    }
  }

  // Planned + active sprints: drive the user toward implement / review.
  if (sprint.status === 'planned' || sprint.status === 'active') {
    if (resumableTaskCount > 0) {
      actions.push({
        id: 'flows-implement',
        label: `Implement ${String(resumableTaskCount)} pending task(s)`,
        hint: 'Run the implement loop — picks tasks in dependency order, commits as it goes.',
        route: { id: 'flows' },
      });
    } else {
      actions.push({
        id: 'open-sprint',
        label: 'Review sprint tasks',
        hint: 'Open the sprint to inspect blocked / done tasks.',
        route: { id: 'sprint-detail', props: { sprintId: sprint.id } },
      });
    }
  }

  if (sprint.status === 'review') {
    actions.push({
      id: 'flows-create-pr',
      label: 'Open a pull request for the sprint',
      hint: 'Sprint is in review — push the branch and surface it for human review.',
      route: { id: 'flows' },
    });
  }

  // Always slot the sprint detail as a tertiary option so the user can drill in directly.
  if (!actions.some((a) => a.id === 'open-sprint') && !actions.some((a) => a.route.id === 'sprint-detail')) {
    actions.push({
      id: 'open-sprint',
      label: `Open sprint '${sprint.name}'`,
      hint: 'Inspect tickets + tasks.',
      route: { id: 'sprint-detail', props: { sprintId: sprint.id } },
    });
  }

  return actions;
};
