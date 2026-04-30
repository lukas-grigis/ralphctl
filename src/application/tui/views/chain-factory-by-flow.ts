/**
 * Maps a `ChainFlow` discriminator to its concrete chain-factory + initial
 * context so `launchWorkflow` doesn't switch on flow names with hard-coded
 * imports inline. Adding a new flow is two edits: extend the union in
 * `menu-action.ts` and add a row in the `FlowInputs` union below. The
 * compiler exhaustiveness check enforces the rest.
 */

import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { Ticket } from '../../../domain/entities/ticket.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import type { SessionId, SessionManagerPort, SessionManagerStartOptions } from '../../runtime/session-manager-port.ts';
import { createCreatePrFlow, type CreatePrCtx } from '../../chains/create-pr/create-pr-flow.ts';
import { createExecuteFlow, type ExecuteCtx } from '../../chains/execute/execute-flow.ts';
import { createFeedbackFlow, type FeedbackCtx } from '../../chains/feedback/feedback-flow.ts';
import { createIdeateFlow, type IdeateCtx } from '../../chains/ideate/ideate-flow.ts';
import { createOnboardFlow, type OnboardCtx } from '../../chains/onboard/onboard-flow.ts';
import { createPlanFlow, type PlanCtx } from '../../chains/plan/plan-flow.ts';
import { createRefineFlow, type RefineCtx } from '../../chains/refine/refine-flow.ts';
import type { ChainFlow } from './menu-action.ts';

/** Resolved per-flow inputs. The `launchWorkflow` helper assembles these. */
export type FlowInputs =
  | {
      readonly flow: 'refine';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
      readonly pendingTickets: readonly Ticket[];
    }
  | {
      readonly flow: 'plan';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
    }
  | {
      readonly flow: 'ideate';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
      readonly projectName: ProjectName;
      readonly ideaText: string;
    }
  | {
      readonly flow: 'execute';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
      readonly sprint: Sprint;
      readonly tasks: readonly Task[];
    }
  | {
      readonly flow: 'feedback';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
      readonly feedbackText: string;
    }
  | {
      readonly flow: 'create-pr';
      readonly sprintId: SprintId;
      readonly cwd: AbsolutePath;
      readonly base: string;
      readonly draft: boolean;
      readonly title?: string;
      readonly body?: string;
      readonly tasks?: readonly Task[];
    }
  | {
      readonly flow: 'onboard';
      readonly projectName: ProjectName;
      readonly repoPath?: AbsolutePath;
      readonly autoAccept?: boolean;
    };

/**
 * Build the chain element + initial context for the flow and start it via
 * the session manager. Returns the new `SessionId`. Caller is responsible
 * for `foreground(sessionId)` and routing to the execute view.
 */
export function startFlowSession(deps: SharedDeps, sessionManager: SessionManagerPort, inputs: FlowInputs): SessionId {
  switch (inputs.flow) {
    case 'refine': {
      const { sprintId, cwd, pendingTickets } = inputs;
      const opts: SessionManagerStartOptions<RefineCtx> = {
        label: `refine ${sprintId}`,
        element: createRefineFlow(deps, { sprintId, cwd, pendingTickets }),
        initialCtx: { sprintId, cwd },
      };
      return sessionManager.start(opts);
    }
    case 'plan': {
      const { sprintId, cwd } = inputs;
      const opts: SessionManagerStartOptions<PlanCtx> = {
        label: `plan ${sprintId}`,
        element: createPlanFlow(deps, { sprintId, cwd }),
        initialCtx: { sprintId, cwd },
      };
      return sessionManager.start(opts);
    }
    case 'ideate': {
      const { sprintId, cwd, projectName, ideaText } = inputs;
      const opts: SessionManagerStartOptions<IdeateCtx> = {
        label: `ideate ${sprintId}`,
        element: createIdeateFlow(deps, { sprintId, cwd, projectName, ideaText }),
        initialCtx: { sprintId, cwd, projectName, ideaText },
      };
      return sessionManager.start(opts);
    }
    case 'execute': {
      const { sprintId, cwd, sprint, tasks } = inputs;
      const opts: SessionManagerStartOptions<ExecuteCtx> = {
        label: `execute ${sprintId}`,
        element: createExecuteFlow(deps, { sprintId, cwd, expectedBranch: '', sprint, tasks }),
        initialCtx: { sprintId, cwd, expectedBranch: '' },
      };
      return sessionManager.start(opts);
    }
    case 'feedback': {
      const { sprintId, cwd, feedbackText } = inputs;
      const opts: SessionManagerStartOptions<FeedbackCtx> = {
        label: `feedback ${sprintId}#1`,
        element: createFeedbackFlow(deps, { sprintId, cwd }),
        initialCtx: { sprintId, cwd, feedbackText, iteration: 1 },
      };
      return sessionManager.start(opts);
    }
    case 'create-pr': {
      const { sprintId, cwd, base, draft, title, body, tasks } = inputs;
      const factoryOpts = {
        sprintId,
        cwd,
        base,
        draft,
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(tasks !== undefined ? { tasks } : {}),
      };
      const initialCtx: CreatePrCtx = {
        sprintId,
        cwd,
        base,
        draft,
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
      };
      const opts: SessionManagerStartOptions<CreatePrCtx> = {
        label: `create-pr ${sprintId}`,
        element: createCreatePrFlow(deps, factoryOpts),
        initialCtx,
      };
      return sessionManager.start(opts);
    }
    case 'onboard': {
      const { projectName, repoPath, autoAccept } = inputs;
      const accept = autoAccept === true;
      const factoryOpts = {
        projectName,
        autoAccept: accept,
        ...(repoPath !== undefined ? { repoPath } : {}),
      };
      const initialCtx: OnboardCtx = {
        projectName,
        autoAccept: accept,
        ...(repoPath !== undefined ? { repoPath } : {}),
      };
      const opts: SessionManagerStartOptions<OnboardCtx> = {
        label: `onboard ${String(projectName)}`,
        element: createOnboardFlow(deps, factoryOpts),
        initialCtx,
      };
      return sessionManager.start(opts);
    }
  }
  const _exhaustive: never = inputs;
  void _exhaustive;
  throw new Error('startFlowSession: unreachable');
}

/** Type-level smoke — every `ChainFlow` must appear in the `FlowInputs` discriminator. */
export type FlowInputsCoversAllFlows = ChainFlow extends FlowInputs['flow'] ? true : false;
