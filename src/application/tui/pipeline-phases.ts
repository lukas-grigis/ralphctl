/**
 * Pipeline-phase derivation — Home's pipeline map reads from this.
 *
 * Given the same `MenuContext` the rest of Home uses, produce a deterministic
 * snapshot of the four sprint-lifecycle phases (Refine / Plan / Execute /
 * Close) with their current status and the action that advances each phase.
 *
 * The derivation covers the *entire* journey — including the pre-states where
 * no sprint exists yet, or a sprint exists but has no tickets. Those become
 * the Refine phase's action (Create Sprint / Add Ticket) so the map is useful
 * from day zero through sprint close.
 *
 * Pure — no I/O, no React. The component layer (`components/pipeline-map.tsx`)
 * renders the snapshot; tests assert the snapshot directly.
 */

import type { SprintId } from '../../domain/values/sprint-id.ts';
import type { MenuAction } from './views/menu-action.ts';

export type PhaseId = 'refine' | 'plan' | 'execute' | 'close';
export type PhaseStatus = 'done' | 'active' | 'pending';

/**
 * A pipeline-map action. The `MenuAction` discriminator drives dispatch;
 * the `label` is the human-readable text rendered next to the row.
 */
export type PhaseAction = MenuAction & { readonly label: string };

export interface Phase {
  readonly id: PhaseId;
  readonly title: string;
  readonly status: PhaseStatus;
  readonly detail: string;
  readonly action: PhaseAction | null;
}

export interface PipelineSnapshot {
  readonly phases: readonly Phase[];
  /** The first non-done phase, or null if every phase is done. */
  readonly currentPhaseId: PhaseId | null;
  /** Shorthand for `phases[currentPhaseId].action` — null when nothing's actionable. */
  readonly nextStep: PhaseAction | null;
}

export interface MenuContext {
  hasProjects: boolean;
  projectCount: number;
  currentSprintId: SprintId | null;
  currentSprintName: string | null;
  currentSprintStatus: 'draft' | 'active' | 'closed' | null;
  ticketCount: number;
  taskCount: number;
  tasksDone: number;
  tasksInProgress: number;
  pendingRequirements: number;
  allRequirementsApproved: boolean;
  plannedTicketCount: number;
  aiProvider: 'claude' | 'copilot' | null;
  /** True when the current sprint has a recorded `branch`. */
  currentSprintHasBranch: boolean;
  /** True when the current sprint has a recorded `pullRequestUrl`. */
  currentSprintHasPullRequest: boolean;
}

function pluralize(n: number, word: string): string {
  return `${String(n)} ${word}${n !== 1 ? 's' : ''}`;
}

// ── action constructors (typed) ──────────────────────────────────────────────

type RouteViewId = Extract<MenuAction, { kind: 'route' }>['viewId'];
type ChainFlowName = Extract<MenuAction, { kind: 'launchChain' }>['flow'];

function routeAction(viewId: RouteViewId, label: string): PhaseAction {
  return { kind: 'route', viewId, label };
}

function chainAction(flow: ChainFlowName, label: string): PhaseAction {
  return { kind: 'launchChain', flow, label };
}

// ── phase computation ────────────────────────────────────────────────────────

function computeRefine(ctx: MenuContext): Phase {
  if (ctx.currentSprintStatus === 'closed') {
    return { id: 'refine', title: 'Refine', status: 'done', detail: 'sprint closed', action: null };
  }
  if (ctx.currentSprintId === null) {
    if (!ctx.hasProjects) {
      return {
        id: 'refine',
        title: 'Refine',
        status: 'pending',
        detail: 'add a project first',
        action: routeAction('project-add', 'Add Project'),
      };
    }
    return {
      id: 'refine',
      title: 'Refine',
      status: 'pending',
      detail: 'no sprint yet',
      action: routeAction('sprint-create', 'Create Sprint'),
    };
  }
  if (ctx.ticketCount === 0) {
    return {
      id: 'refine',
      title: 'Refine',
      status: 'pending',
      detail: ctx.hasProjects ? 'no tickets yet' : 'add a project first',
      action: ctx.hasProjects ? routeAction('ticket-add', 'Add Ticket') : null,
    };
  }
  if (!ctx.allRequirementsApproved) {
    const approved = ctx.ticketCount - ctx.pendingRequirements;
    const canRefine = ctx.currentSprintStatus === 'draft';
    return {
      id: 'refine',
      title: 'Refine',
      status: 'active',
      detail: `${String(approved)}/${String(ctx.ticketCount)} tickets approved`,
      action: canRefine ? chainAction('refine', 'Refine Requirements') : null,
    };
  }
  return {
    id: 'refine',
    title: 'Refine',
    status: 'done',
    detail: `${pluralize(ctx.ticketCount, 'ticket')} approved`,
    action: null,
  };
}

function computePlan(ctx: MenuContext): Phase {
  if (ctx.currentSprintStatus === 'closed') {
    return { id: 'plan', title: 'Plan', status: 'done', detail: 'sprint closed', action: null };
  }
  if (ctx.currentSprintId === null || ctx.ticketCount === 0) {
    return { id: 'plan', title: 'Plan', status: 'pending', detail: 'awaiting tickets', action: null };
  }
  if (!ctx.allRequirementsApproved) {
    return { id: 'plan', title: 'Plan', status: 'pending', detail: 'awaiting refinement', action: null };
  }
  const isDraft = ctx.currentSprintStatus === 'draft';
  if (ctx.taskCount === 0) {
    return {
      id: 'plan',
      title: 'Plan',
      status: 'active',
      detail: 'ready to plan tasks',
      action: isDraft ? chainAction('plan', 'Plan Tasks') : null,
    };
  }
  if (ctx.plannedTicketCount < ctx.ticketCount) {
    return {
      id: 'plan',
      title: 'Plan',
      status: 'active',
      detail: `${String(ctx.plannedTicketCount)}/${String(ctx.ticketCount)} tickets planned`,
      action: isDraft ? chainAction('plan', 'Re-Plan Tasks') : null,
    };
  }
  return {
    id: 'plan',
    title: 'Plan',
    status: 'done',
    detail: `${pluralize(ctx.taskCount, 'task')} generated`,
    action: null,
  };
}

function computeExecute(ctx: MenuContext): Phase {
  if (ctx.taskCount === 0) {
    return { id: 'execute', title: 'Execute', status: 'pending', detail: 'no tasks yet', action: null };
  }
  if (ctx.currentSprintStatus === 'closed') {
    return {
      id: 'execute',
      title: 'Execute',
      status: 'done',
      detail: `${String(ctx.tasksDone)}/${String(ctx.taskCount)} tasks done`,
      action: null,
    };
  }
  if (ctx.tasksDone === ctx.taskCount) {
    return {
      id: 'execute',
      title: 'Execute',
      status: 'done',
      detail: `all ${pluralize(ctx.taskCount, 'task')} done`,
      action: null,
    };
  }
  const parts = [`${String(ctx.tasksDone)}/${String(ctx.taskCount)} done`];
  if (ctx.tasksInProgress > 0) parts.push(`${String(ctx.tasksInProgress)} running`);
  const detail = parts.join(' · ');
  if (ctx.currentSprintStatus === 'active') {
    const remaining = ctx.taskCount - ctx.tasksDone;
    return {
      id: 'execute',
      title: 'Execute',
      status: 'active',
      detail,
      action: chainAction('execute', `Continue Work (${pluralize(remaining, 'task')} left)`),
    };
  }
  // Draft sprint with tasks — ready to start
  return {
    id: 'execute',
    title: 'Execute',
    status: 'active',
    detail,
    action: chainAction('execute', 'Start Sprint'),
  };
}

function computeClose(ctx: MenuContext): Phase {
  if (ctx.currentSprintStatus === 'closed') {
    return { id: 'close', title: 'Close', status: 'done', detail: 'sprint closed', action: null };
  }
  if (ctx.currentSprintStatus === 'active' && ctx.taskCount > 0 && ctx.tasksDone === ctx.taskCount) {
    // When the sprint has a branch and no PR yet, the user's next forward
    // step is to publish the PR — close-sprint comes after. Once a PR has
    // been recorded (or there's no branch to publish from), fall back to
    // the close action.
    if (ctx.currentSprintHasBranch && !ctx.currentSprintHasPullRequest) {
      return {
        id: 'close',
        title: 'Close',
        status: 'active',
        detail: 'ready to publish PR',
        action: chainAction('create-pr', 'Create PR / MR'),
      };
    }
    return {
      id: 'close',
      title: 'Close',
      status: 'active',
      detail: 'all tasks done',
      action: routeAction('sprint-close', 'Close Sprint'),
    };
  }
  return { id: 'close', title: 'Close', status: 'pending', detail: 'pending', action: null };
}

export function computePipelineSnapshot(ctx: MenuContext): PipelineSnapshot {
  const phases: readonly Phase[] = [computeRefine(ctx), computePlan(ctx), computeExecute(ctx), computeClose(ctx)];
  const current = phases.find((p) => p.status !== 'done');
  // When the sprint is closed (every phase `done`), there's no in-flight
  // action — but the user still needs a clear forward path. Offer creating
  // a new sprint as the quick-action so Home doesn't stall on a finished run.
  const postClose: PhaseAction | null =
    current === undefined && ctx.currentSprintStatus === 'closed'
      ? routeAction('sprint-create', 'Start a new sprint')
      : null;
  return {
    phases,
    currentPhaseId: current ? current.id : null,
    nextStep: current?.action ?? postClose,
  };
}
