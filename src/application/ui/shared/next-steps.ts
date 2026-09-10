/**
 * "Given where this run / sprint ended up, what should the operator do next?" — one pure
 * function, three surfaces:
 *
 *  - the settled `ResultCard` in the Execute-view footer (`result-footer.tsx`),
 *  - Home's `ActiveSprintCard` (`home-internals/state-card.tsx`),
 *  - the Flows `OrientationCard` (`flows-view.tsx`).
 *
 * Home and Flows each used to derive their own wording, and they disagreed: Home advised
 * `create-pr` at `review` — a flow `flows-visibility.ts` HIDES in that state — and went silent at
 * `done`, where Flows had the right answer. Folding both onto this table is a behaviour fix, not
 * a copy cleanup; the unit test asserts every recommended flow name against `visibleFlowsFor`.
 *
 * Input shape: a flat bag of primitives rather than an `AppStateSnapshot`. Home and Flows hold a
 * snapshot, but the settled footer holds only a `SessionDescriptor` + the run's pinned sprint;
 * a snapshot-shaped input would force a second repo-polling loop into the Execute view.
 * {@link nextStepsInputFromSnapshot} keeps the two snapshot call sites one line each.
 */

import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import { computeTaskHealthCounts, type AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export interface NextStep {
  /**
   * Emitted only for chords that resolve identically on EVERY surface: the global `n` / `P` / `S`
   * and the contextual `+` (see `keyboard-map.ts`), plus `r` on the settled-run surface that
   * claims it. Home's `c` / `a` and the Flows `r` (reload) are view-local, so steps that need
   * those render keyless with the route spelled out in {@link detail}.
   */
  readonly key?: string;
  /** Single-verb imperative — DESIGN-SYSTEM § 8.2. `run <flow>` is the only shape naming a flow. */
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
  /** Settled-run surface only; undefined on Home / Flows (and while a run is still live). */
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

/**
 * The settled-run prepend. A completed run adds nothing — the sprint-state rows below already
 * say what to do; a failed / aborted run gets `r`, which routes to Flows rather than relaunching
 * blind (see `use-execute-input.ts` for why that distinction is load-bearing).
 */
const runStatusRows = (input: NextStepsInput): readonly NextStep[] => {
  if (input.runStatus === 'failed') {
    return [
      {
        key: 'r',
        label: 're-run from Flows',
        detail:
          input.failedLeafLabel !== undefined
            ? `${input.failedLeafLabel} failed — triggers are re-checked first`
            : 'triggers are re-checked against the current sprint state',
      },
    ];
  }
  if (input.runStatus === 'aborted') {
    return [{ key: 'r', label: 're-run from Flows', detail: 'the cancelled step left the sprint unchanged' }];
  }
  return [];
};

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Rows for a context with no sprint yet. Home renders a dedicated hero card in these regimes and
 * keeps it — these exist so the settled-run and Flows surfaces have something to say too. Do not
 * "unify" Home's heroes into these rows; a full-width CTA and a one-line hint are different jobs.
 */
const preSprintRows = (input: NextStepsInput): readonly NextStep[] => {
  if (!input.hasProject) {
    return input.projectCount === 0
      ? [{ label: 'create a project', detail: 'Home, press c' }]
      : [{ key: 'P', label: 'pick a project', detail: `${plural(input.projectCount, 'project')} in storage` }];
  }
  return input.sprintCount === 0
    ? [{ key: '+', label: 'create the first sprint' }]
    : [{ key: 'S', label: 'pick a sprint', detail: `${plural(input.sprintCount, 'sprint')} in this project` }];
};

/**
 * Detail line for the blocked-task callout below — states the counts without asserting a causal
 * link between the own- and upstream-blocked subsets (an upstream-blocked task's own root
 * prerequisite may be a still-`todo` task rather than one of the own-blocked ones counted here).
 *
 * `sprintIsDone` appends the reopen callout: at every other status `u` unblocks in place, but on
 * a `done` sprint it also reopens it (`done` → `review` → `active` — see `unblock-task.ts`'s
 * "Sprint reopen" doc block), which the plain wording below would otherwise leave unsaid.
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
 * Blocked-task callout, prepended ahead of the ordinary status row at planned / active / review
 * / done whenever the sprint has stuck work. Independent of `resumableTaskCount` (which excludes
 * `blocked` entirely) so it shows up even when there is ALSO resumable work to run.
 *
 * `done` is not a dead end: unblocking a task there reopens the sprint (see `blockedTaskDetail`'s
 * `sprintIsDone` note) rather than leaving it permanently unreachable, so this row belongs there
 * too — a closed sprint with stuck tasks must keep pointing at how to get them running again.
 *
 * Keyless: `u` bulk-unblocks from the Sprints list and from sprint-detail, neither of which this
 * table's surfaces (Home / Flows / the settled ResultCard) route through — see `NextStep.key`'s
 * doc comment on why a key here would advertise a chord this row's own surface doesn't bind. The
 * detail names the route instead.
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

/**
 * Rows for a loaded sprint, keyed on its lifecycle status. Every `run <flow>` name here is
 * cross-checked against `ALLOWED_BY_STATUS` (`flows-visibility.ts`) by the unit test — a status
 * must never recommend a flow its own menu hides.
 */
const sprintRows = (status: SprintStatus, input: NextStepsInput): readonly NextStep[] => {
  switch (status) {
    case 'draft':
      if (input.ticketCount === 0) return [{ label: 'add a ticket', detail: 'open the sprint, press a' }];
      if (input.pendingTicketCount > 0) {
        return [
          { key: 'n', label: 'run refine', detail: `clarify ${plural(input.pendingTicketCount, 'pending ticket')}` },
        ];
      }
      if (input.approvedTicketCount > 0) {
        return [
          {
            key: 'n',
            label: 'run plan',
            detail: `break ${plural(input.approvedTicketCount, 'approved ticket')} into tasks`,
          },
        ];
      }
      return [{ key: 'n', label: 'run refine', detail: 'no ticket is approved yet' }];
    case 'planned':
    case 'active': {
      const blocked = blockedTaskRow(input);
      if (input.resumableTaskCount > 0) {
        return [
          ...blocked,
          { key: 'n', label: 'run implement', detail: `${plural(input.resumableTaskCount, 'task')} pending` },
        ];
      }
      // Every remaining task is blocked (not merely idle) — the blocked row above already says
      // so with a real count; only fall back to the vague "nothing pending" line when there is
      // truly nothing left to explain (no resumable AND no blocked task).
      return blocked.length > 0
        ? blocked
        : [{ label: 'open the sprint and unblock stuck tasks', detail: 'no task is left to run' }];
    }
    case 'review':
      // Two status rows on purpose: both flows are visible at `review` and both are legitimate.
      // The single-string design this replaced could not express the choice, so it picked one.
      return [
        ...blockedTaskRow(input),
        { key: 'n', label: 'run review', detail: "apply the evaluator's feedback" },
        { key: 'n', label: 'run close-sprint', detail: 'mark the sprint done' },
      ];
    case 'done':
      // A closed sprint with blocked tasks is not "nothing left" — the confirm-and-proceed
      // close-sprint gate lets a sprint close with blocked work still in it, and unblocking one
      // of those tasks reopens the sprint (see `blockedTaskRow`'s doc comment). Every other
      // orientation surface (the Sprints list badge, the picker badge, sprint-detail's header)
      // already says so; this table used to be the one place that went silent.
      return [...blockedTaskRow(input, true), { key: 'n', label: 'run create-pr', detail: 'open a pull request' }];
  }
};

/**
 * Pure — never touches the filesystem and never builds a path. Forensic paths are resolved and
 * existence-checked by the caller (`use-run-forensics.ts`) and passed straight through.
 */
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
