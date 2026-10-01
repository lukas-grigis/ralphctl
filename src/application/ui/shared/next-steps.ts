/** "Given where this run / sprint ended up, what should the operator do next?" — one pure function. */

import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import { computeTaskHealthCounts, type AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { plural } from '@src/application/ui/shared/plural.ts';

export interface NextStep {
  /**
   * A chord that does the step's job (`c` create, `a` add ticket, `S` / `P` switch, `r` on the settled-run surface).
   */
  readonly key?: string;
  /** Registry id when this row IS a flow launch; `label` then carries the display name. */
  readonly flow?: string;
  /** Single-verb imperative — DESIGN-SYSTEM § 8.2 — or, on a flow row, the flow's display name. */
  readonly label: string;
  /** Dim parenthetical: the count, or the why. */
  readonly detail?: string;
}

/** One post-mortem artifact, already resolved AND existence-checked by the caller. */
export interface ForensicPath {
  readonly label: string;
  readonly path: string;
}

export interface NextStepsInput {
  /** Settled-run surface only; undefined on Work (and while a run is still live). */
  readonly runStatus?: 'completed' | 'failed' | 'aborted';
  /** Display label of the leaf that failed, from the trace. Colours the failed prepend only. */
  readonly failedLeafLabel?: string;
  readonly hasProject: boolean;
  readonly projectCount: number;
  readonly sprintCount: number;
  /** Undefined ⇒ no sprint in context, so the pre-sprint rows answer instead. */
  readonly sprintStatus?: SprintStatus;
  readonly ticketCount: number;
  readonly pendingTicketCount: number;
  readonly approvedTicketCount: number;
  readonly resumableTaskCount: number;
  /** Every `blocked` task, upstream + own combined — see {@link computeTaskHealthCounts}. */
  readonly blockedTaskCount: number;
  /** Subset of `blockedTaskCount` blocked solely on an unfinished prerequisite. */
  readonly upstreamBlockedTaskCount: number;
  /** Pre-resolved + existence-checked by the caller. Empty / omitted ⇒ no post-mortem block. */
  readonly forensics?: readonly ForensicPath[];
}

export interface NextSteps {
  readonly steps: readonly NextStep[];
  readonly forensics: readonly ForensicPath[];
}

/** The settled-run prepend. */
const runStatusRows = (input: NextStepsInput): readonly NextStep[] => {
  if (input.runStatus === 'failed') {
    return [
      {
        key: 'r',
        label: 're-run from Work',
        detail:
          input.failedLeafLabel !== undefined
            ? `${input.failedLeafLabel} failed — triggers are re-checked first`
            : 'triggers are re-checked against the current sprint state',
      },
    ];
  }
  if (input.runStatus === 'aborted') {
    return [{ key: 'r', label: 're-run from Work', detail: 'the cancelled step left the sprint unchanged' }];
  }
  return [];
};

const flowStep = (flow: string, label: string, detail: string): NextStep => ({ flow, label, detail });

/** Rows for a context with no sprint yet. */
const preSprintRows = (input: NextStepsInput): readonly NextStep[] => {
  if (!input.hasProject) {
    return input.projectCount === 0
      ? [{ key: 'c', label: 'create a project' }]
      : [{ key: 'P', label: 'pick a project', detail: `${plural(input.projectCount, 'project')} in storage` }];
  }
  return input.sprintCount === 0
    ? [{ key: 'c', label: 'create the first sprint' }]
    : [{ key: 'S', label: 'switch sprint', detail: `${plural(input.sprintCount, 'sprint')} in this project` }];
};

/**
 * Detail line for the blocked-task callout below.
 */
const blockedTaskDetail = (
  blockedTaskCount: number,
  upstreamBlockedTaskCount: number,
  sprintIsDone: boolean
): string => {
  const ownBlockedTaskCount = blockedTaskCount - upstreamBlockedTaskCount;
  const reopenNote = sprintIsDone ? ' — u reopens the sprint' : '';
  if (ownBlockedTaskCount === 0) {
    return `${plural(blockedTaskCount, 'task')} waiting on a prerequisite${reopenNote}`;
  }
  if (upstreamBlockedTaskCount === 0) return `open the sprint and press u${reopenNote}`;
  // `more` is an adverb, not a noun — running it through `plural` (which only knows how to
  // append a bare `s`) rendered "2 mores upstream". Interpolate the count directly instead.
  return `${plural(ownBlockedTaskCount, 'task')} to fix, ${String(upstreamBlockedTaskCount)} more upstream${reopenNote}`;
};

/**
 * Blocked-task callout, prepended ahead of the ordinary status row at planned / active / review / done whenever the
 * sprint has stuck work.
 */
const blockedTaskRow = (input: NextStepsInput, sprintIsDone = false): readonly NextStep[] =>
  input.blockedTaskCount <= 0
    ? []
    : [
        {
          label: `unblock ${plural(input.blockedTaskCount, 'blocked task')}`,
          detail: blockedTaskDetail(input.blockedTaskCount, input.upstreamBlockedTaskCount, sprintIsDone),
        },
      ];

/** Rows for a loaded sprint, keyed on its lifecycle status. */
const sprintRows = (status: SprintStatus, input: NextStepsInput): readonly NextStep[] => {
  switch (status) {
    case 'draft':
      if (input.ticketCount === 0) return [{ key: 'a', label: 'add a ticket' }];
      if (input.pendingTicketCount > 0) {
        return [flowStep('refine', 'Refine', `clarify ${plural(input.pendingTicketCount, 'pending ticket')}`)];
      }
      if (input.approvedTicketCount > 0) {
        return [flowStep('plan', 'Plan', `break ${plural(input.approvedTicketCount, 'approved ticket')} into tasks`)];
      }
      return [flowStep('refine', 'Refine', 'no ticket is approved yet')];
    case 'planned':
    case 'active': {
      const blocked = blockedTaskRow(input);
      if (input.resumableTaskCount > 0) {
        return [...blocked, flowStep('implement', 'Implement', `${plural(input.resumableTaskCount, 'task')} pending`)];
      }
      // Every remaining task is blocked (not merely idle) — the blocked row above already says so with a real count.
      return blocked.length > 0
        ? blocked
        : [{ label: 'open the sprint and unblock stuck tasks', detail: 'no task is left to run' }];
    }
    case 'review':
      // Three status rows on purpose: all three flows are visible at `review` and all are
      // legitimate. Review leads so the pipeline stage and the first flow row agree.
      return [
        ...blockedTaskRow(input),
        flowStep('review', 'Review', "apply the evaluator's feedback"),
        flowStep('create-pr', 'Create PR', 'open a pull request'),
        flowStep('close-sprint', 'Close sprint', 'mark the sprint done'),
      ];
    case 'done':
      // A closed sprint with blocked tasks is not "nothing left" — the confirm-and-proceed close-sprint gate lets a
      // sprint close with blocked work still in it.
      return [...blockedTaskRow(input, true), flowStep('create-pr', 'Create PR', 'open a pull request')];
  }
};

/** Pure — never touches the filesystem and never builds a path. */
export const buildNextSteps = (input: NextStepsInput): NextSteps => {
  const stateRows = input.sprintStatus !== undefined ? sprintRows(input.sprintStatus, input) : preSprintRows(input);
  return { steps: [...runStatusRows(input), ...stateRows], forensics: input.forensics ?? [] };
};

/** Adapter for the two surfaces that hold an {@link AppStateSnapshot}. */
export const nextStepsInputFromSnapshot = (
  snapshot: AppStateSnapshot
): Omit<NextStepsInput, 'runStatus' | 'failedLeafLabel' | 'forensics'> => {
  const { pendingTicketCount, approvedTicketCount, resumableTaskCount } = snapshot.triggerInputs;
  const { blockedTaskCount, upstreamBlockedTaskCount } = computeTaskHealthCounts(snapshot.tasks);
  return {
    hasProject: snapshot.project !== undefined,
    projectCount: snapshot.projectCount,
    sprintCount: snapshot.sprintCount,
    ...(snapshot.sprint !== undefined ? { sprintStatus: snapshot.sprint.status } : {}),
    ticketCount: snapshot.sprint?.tickets.length ?? 0,
    pendingTicketCount,
    approvedTicketCount,
    resumableTaskCount,
    blockedTaskCount,
    upstreamBlockedTaskCount,
  };
};
