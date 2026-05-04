/**
 * Maps a `ChainFlow` discriminator to its concrete chain-factory + initial
 * context so `launchWorkflow` doesn't switch on flow names with hard-coded
 * imports inline. Adding a new flow is two edits: extend the union in
 * `menu-action.ts` and add a row in the `FlowInputs` union below. The
 * compiler exhaustiveness check enforces the rest.
 */

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type {
  SessionId,
  SessionManagerPort,
  SessionManagerStartOptions,
} from '@src/application/runtime/session-manager-port.ts';
import { runInteractive } from '@src/application/runtime/interactive-terminal.ts';
import { createCreatePrFlow, type CreatePrCtx } from '@src/application/chains/create-pr/create-pr-flow.ts';
import { createExecuteFlow, type ExecuteCtx } from '@src/application/chains/execute/execute-flow.ts';
import { createFeedbackFlow, type FeedbackCtx } from '@src/application/chains/feedback/feedback-flow.ts';
import { createIdeateFlow, type IdeateCtx } from '@src/application/chains/ideate/ideate-flow.ts';
import { createOnboardFlow, type OnboardCtx } from '@src/application/chains/onboard/onboard-flow.ts';
import { createPlanFlow, type PlanCtx } from '@src/application/chains/plan/plan-flow.ts';
import { createRefineFlow, type RefineCtx } from '@src/application/chains/refine/refine-flow.ts';
import type { ChainFlow } from './menu-action.ts';

/** Resolved per-flow inputs. The `launchWorkflow` helper assembles these. */
export type FlowInputs =
  | {
      readonly flow: 'refine';
      readonly sprintId: SprintId;
      readonly pendingTickets: readonly Ticket[];
      /**
       * When true, run Claude with stdio: 'inherit' for each ticket
       * (Claude Code UI takes over the terminal); refined requirements
       * are read back from `<unit-root>/requirements.json`. Defaults to
       * true on TTY contexts.
       */
      readonly interactive?: boolean;
    }
  | {
      readonly flow: 'plan';
      readonly sprintId: SprintId;
      readonly interactive?: boolean;
      readonly outputFilePath?: string;
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
      const { sprintId, pendingTickets, interactive } = inputs;
      // Refine drives a per-ticket interactive Claude conversation —
      // backgrounding it would orphan a session awaiting user input.
      // Single-instance per sprint: a second click while the first run
      // is live lands the user on the existing session.
      //
      // No `cwd` from the launcher — refine runs inside a per-ticket
      // sandbox materialised by the chain's `build-refinement-unit`
      // leaf. Refine is implementation-agnostic and never reaches into
      // user repos.
      const factoryOpts = {
        sprintId,
        pendingTickets,
        ...(interactive !== undefined ? { interactive } : {}),
        // Hand the runInteractive helper to the chain so per-ticket leaves
        // can pause Ink + exit alt-screen + spawn Claude with stdio:inherit.
        runInTerminal: runInteractive,
      };
      const opts: SessionManagerStartOptions<RefineCtx> = {
        label: `refine ${sprintId}`,
        element: createRefineFlow(deps, factoryOpts),
        initialCtx: { sprintId, ...(interactive !== undefined ? { interactive } : {}) },
        detachable: false,
        dedupeKey: `refine:${String(sprintId)}`,
      };
      return sessionManager.start(opts);
    }
    case 'plan': {
      const { sprintId, interactive, outputFilePath } = inputs;
      // Plan drives an interactive AI session — single-instance per sprint,
      // foreground-only. Repo selection happens INSIDE the chain via the
      // `persist-repo-selection` leaf; the AI session cwd is the per-sprint
      // sandbox stamped by the chain's `build-plan-workspace` leaf.
      const factoryOpts = {
        sprintId,
        ...(interactive !== undefined ? { interactive } : {}),
        ...(outputFilePath !== undefined ? { outputFilePath } : {}),
        runInTerminal: runInteractive,
      };
      const opts: SessionManagerStartOptions<PlanCtx> = {
        label: `plan ${sprintId}`,
        element: createPlanFlow(deps, factoryOpts),
        initialCtx: { sprintId },
        detachable: false,
        dedupeKey: `plan:${String(sprintId)}`,
      };
      return sessionManager.start(opts);
    }
    case 'ideate': {
      const { sprintId, cwd, projectName, ideaText } = inputs;
      // Ideate is interactive (refine + plan rolled into one) — single-instance
      // per sprint, foreground-only.
      const opts: SessionManagerStartOptions<IdeateCtx> = {
        label: `ideate ${sprintId}`,
        element: createIdeateFlow(deps),
        initialCtx: { sprintId, cwd, projectName, ideaText },
        detachable: false,
        dedupeKey: `ideate:${String(sprintId)}`,
      };
      return sessionManager.start(opts);
    }
    case 'execute': {
      const { sprintId, cwd, sprint, tasks } = inputs;
      // Execute CAN be backgrounded (long-running task fan-out, no inline
      // prompts) but is still single-instance per sprint — two parallel
      // runs would race on the same task state.
      //
      // Seed `expectedBranch` from the persisted sprint branch (resume
      // case). When `sprint.branch === null`, the chain's `resolve-branch`
      // leaf prompts the user inside the chain — the launcher itself
      // doesn't prompt.
      const expectedBranch = sprint.branch ?? '';
      const opts: SessionManagerStartOptions<ExecuteCtx> = {
        label: `execute ${sprintId}`,
        element: createExecuteFlow(deps, { sprintId, cwd, expectedBranch, sprint, tasks }),
        initialCtx: { sprintId, cwd, expectedBranch },
        dedupeKey: `execute:${String(sprintId)}`,
      };
      return sessionManager.start(opts);
    }
    case 'feedback': {
      const { sprintId, cwd, feedbackText } = inputs;
      const opts: SessionManagerStartOptions<FeedbackCtx> = {
        label: `feedback ${sprintId}#1`,
        element: createFeedbackFlow(deps),
        initialCtx: { sprintId, cwd, feedbackText, iteration: 1 },
        dedupeKey: `feedback:${String(sprintId)}`,
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
        dedupeKey: `create-pr:${String(sprintId)}`,
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
      // Onboard is single-instance per REPO (not per project) — onboarding
      // two different repos in the same project concurrently is fine and
      // expected (different working trees). What's not fine is launching
      // the same repo's onboard twice. The dedupeKey carries the repo
      // path so a second click on the same repo lands the user on the
      // running session instead of spawning a duplicate.
      //
      // Foreground-only: the chain runs interactive confirm prompts and
      // would orphan an awaiting UI if backgrounded.
      const dedupeTarget = repoPath !== undefined ? String(repoPath) : `${String(projectName)}:default`;
      const opts: SessionManagerStartOptions<OnboardCtx> = {
        label: `onboard ${String(projectName)}`,
        element: createOnboardFlow(deps, factoryOpts),
        initialCtx,
        dedupeKey: `onboard:${dedupeTarget}`,
        detachable: false,
      };
      return sessionManager.start(opts);
    }
  }
  const _exhaustive: never = inputs;
  void _exhaustive;
  throw new Error('startFlowSession: unreachable');
}

// Type-level smoke — fails the build if a new `ChainFlow` is added without a
// matching `FlowInputs` variant. The assertion is the value, not the type.
const _flowInputsCoversAllFlows: ChainFlow extends FlowInputs['flow'] ? true : false = true;
void _flowInputsCoversAllFlows;
