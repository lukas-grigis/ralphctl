/**
 * `launchWorkflow` — given a `ChainFlow` discriminator, resolve the inputs the
 * factory needs (current sprint, cwd, prompts, etc.), build the chain, and
 * start it on the session manager.
 *
 * Extracted from `home-view.tsx` so the dispatcher there can stay a thin
 * `switch (action.kind)` over a typed `MenuAction`. Each flow performs its
 * own pre-flight validation and may throw — callers wrap in try/catch and
 * surface the message to the user. Returns `null` when the user cancelled
 * (e.g. declined a "no current sprint, create one?" prompt) — the caller
 * may then choose to push a different view (e.g. `sprint-create`).
 */

import { ActivateSprintUseCase } from '@src/business/usecases/sprint/activate-sprint.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import type { SessionId, SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';
import { startFlowSession, type FlowInputs } from './chain-factory-by-flow.ts';
import type { ChainFlow } from './menu-action.ts';
import type { RouterApi } from './router-context.ts';

interface LaunchOptions {
  readonly deps: SharedDeps;
  readonly sessionManager: SessionManagerPort;
  readonly router: RouterApi;
}

/**
 * Resolve the cwd to run a chain in: prefer the current sprint's first
 * `affectedRepositories` entry (set during plan), else the sprint's
 * project's first registered repo, else the first registered project's
 * first repo, else `process.cwd()`.
 */
async function resolveCwd(deps: SharedDeps): Promise<AbsolutePath> {
  try {
    const config = await deps.configStore.load();
    if (config.ok && config.value.currentSprint) {
      const idResult = SprintId.parse(config.value.currentSprint);
      if (idResult.ok) {
        const sprintResult = await deps.sprintRepo.findById(idResult.value);
        if (sprintResult.ok) {
          const sprint = sprintResult.value;
          // Plan has run: use the first selected repo as canonical cwd.
          const planned = sprint.affectedRepositories[0];
          if (planned !== undefined) return planned;
          // Plan hasn't run yet: fall back to the sprint's project's
          // first repo so refine / ideate still get a valid cwd.
          const projectResult = await deps.projectRepo.findByName(sprint.projectName);
          if (projectResult.ok) {
            const repo = projectResult.value.repositories[0];
            if (repo) return repo.path;
          }
        }
      }
    }
    const projectsResult = await deps.projectRepo.list();
    if (projectsResult.ok && projectsResult.value.length > 0) {
      const first = projectsResult.value[0];
      if (first?.repositories.length) {
        const repo = first.repositories[0];
        if (repo) return repo.path;
      }
    }
  } catch {
    // fall through
  }
  return AbsolutePath.trustString(process.cwd());
}

/**
 * Load the current sprint id, prompting to create one if absent. Returns
 * `null` when the user has no sprint and either declined or accepted (in
 * which case the caller routes to `sprint-create`).
 */
async function loadCurrentSprintIdOrPrompt(
  deps: SharedDeps,
  router: RouterApi,
  promptOnMissing: boolean
): Promise<SprintId | null> {
  const config = await deps.configStore.load();
  if (!config.ok || !config.value.currentSprint) {
    if (!promptOnMissing) return null;
    const create = await deps.prompt.confirm({ message: 'No current sprint. Create one first?' });
    if (create) router.push({ id: 'sprint-create' });
    return null;
  }
  const idResult = SprintId.parse(config.value.currentSprint);
  if (!idResult.ok) throw new Error('Invalid sprint id in config');
  return idResult.value;
}

async function buildRefineInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;
  const sprintResult = await deps.sprintRepo.findById(sprintId);
  if (!sprintResult.ok) throw new Error(sprintResult.error.message);
  const sprint = sprintResult.value;
  const pendingTickets = sprint.tickets.filter((t) => t.requirementStatus === 'pending');
  if (pendingTickets.length === 0) throw new Error('No pending tickets to refine');
  // No `cwd` from the launcher — the chain's `build-refinement-unit`
  // leaf materialises a sandbox under `<sprintDir>/refinement/<unit>/`
  // and stamps `ctx.cwd` so every AI session lives inside it. Per-ticket
  // output (`requirements.json`) and the rendered prompt (`prompt.md`)
  // both land inside the same unit folder — see refine-flow.ts.
  //
  // Default to interactive on a TTY — that's the 0.5.0 behaviour the
  // user expects (full Claude Code UI per ticket). Non-TTY (CI / piped
  // / RALPHCTL_NO_TUI) falls back to headless automatically.
  const interactive = process.stdout.isTTY && process.env['RALPHCTL_NO_TUI'] !== '1';
  return { flow: 'refine', sprintId, pendingTickets, interactive };
}

async function buildPlanInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;
  const sprintResult = await deps.sprintRepo.findById(sprintId);
  if (!sprintResult.ok) throw new Error(sprintResult.error.message);
  const sprint = sprintResult.value;
  if (sprint.tickets.length === 0 || !sprint.hasApprovedAllTickets()) {
    throw new Error('All tickets must be approved before planning. Run Refine first.');
  }

  // Repo selection happens INSIDE the plan chain via the
  // `persist-repo-selection` leaf — it loads the project, prompts (or
  // skips for single-repo projects), and writes the result onto
  // `sprint.affectedRepositories`. The AI session's cwd is the per-sprint
  // sandbox stamped by the chain's `build-plan-workspace` leaf — the
  // launcher does not supply one.

  // Default to interactive on a TTY; CI / piped falls back to headless.
  // The output file path only matters in interactive mode (headless
  // captures from stdout) — leave it unset otherwise so the field
  // doesn't suggest it's used in both modes.
  const interactive = process.stdout.isTTY && process.env['RALPHCTL_NO_TUI'] !== '1';
  const sprintDir = String(deps.storage.sprintDir(sprintId));
  return {
    flow: 'plan',
    sprintId,
    interactive,
    ...(interactive ? { outputFilePath: `${sprintDir}/planning/tasks.json` } : {}),
  };
}

async function buildIdeateInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;
  const projectsResult = await deps.projectRepo.list();
  if (!projectsResult.ok || projectsResult.value.length === 0) {
    throw new Error('No projects registered. Add one first.');
  }
  const projectChoices = projectsResult.value.map((p) => ({ label: String(p.name), value: String(p.name) }));
  const selectedName = await deps.prompt.select<string>({
    message: 'Select project for ideation',
    choices: projectChoices,
  });
  const projectNameResult = ProjectName.parse(selectedName);
  if (!projectNameResult.ok) throw new Error('Invalid project name');
  const ideaText = await deps.prompt.input({ message: 'Describe your idea' });
  const trimmed = ideaText.trim();
  if (!trimmed) throw new Error('Idea text cannot be empty');
  const cwd = await resolveCwd(deps);
  return {
    flow: 'ideate',
    sprintId,
    cwd,
    projectName: projectNameResult.value,
    ideaText: trimmed,
  };
}

async function buildExecuteInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;

  const sprintLoaded = await deps.sprintRepo.findById(sprintId);
  if (!sprintLoaded.ok) throw new Error(sprintLoaded.error.message);
  if (sprintLoaded.value.status === 'closed') throw new Error('Sprint is already closed');
  if (sprintLoaded.value.status === 'draft') {
    const activated = await new ActivateSprintUseCase(deps.sprintRepo).execute({
      id: sprintId,
      now: IsoTimestamp.now(),
    });
    if (!activated.ok) throw new Error(activated.error.message);
  }

  const sprintActive = await deps.sprintRepo.findById(sprintId);
  if (!sprintActive.ok) throw new Error(sprintActive.error.message);
  const tasksResult = await deps.taskRepo.findBySprintId(sprintId);
  if (!tasksResult.ok) throw new Error(tasksResult.error.message);
  if (tasksResult.value.length === 0) throw new Error('No tasks to execute. Run Plan first.');

  const cwd = await resolveCwd(deps);
  return {
    flow: 'execute',
    sprintId,
    cwd,
    sprint: sprintActive.value,
    tasks: tasksResult.value,
  };
}

async function buildFeedbackInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;
  const feedbackText = await deps.prompt.input({ message: 'Enter feedback for the AI' });
  const trimmed = feedbackText.trim();
  if (!trimmed) return null;
  const cwd = await resolveCwd(deps);
  return { flow: 'feedback', sprintId, cwd, feedbackText: trimmed };
}

async function buildCreatePrInputs(deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  const sprintId = await loadCurrentSprintIdOrPrompt(deps, router, true);
  if (sprintId === null) return null;

  const sprintResult = await deps.sprintRepo.findById(sprintId);
  if (!sprintResult.ok) throw new Error(sprintResult.error.message);
  if (sprintResult.value.branch === null) {
    throw new Error('Sprint has no branch — start the sprint with --branch first.');
  }

  const tasksResult = await deps.taskRepo.findBySprintId(sprintId);
  const tasks = tasksResult.ok ? tasksResult.value : [];

  const cwd = await resolveCwd(deps);
  // Defaults are derived inside the chain via `derive-pr-content`.
  // No inline confirm here — the CLI / TUI surfaces handle UX before launch.
  return {
    flow: 'create-pr',
    sprintId,
    cwd,
    base: 'main',
    draft: false,
    tasks,
  };
}

async function buildOnboardInputs(deps: SharedDeps): Promise<FlowInputs | null> {
  const projectsResult = await deps.projectRepo.list();
  if (!projectsResult.ok || projectsResult.value.length === 0) {
    throw new Error('No projects registered. Add one first.');
  }

  let selectedProject = projectsResult.value[0];
  if (projectsResult.value.length > 1) {
    const choices = projectsResult.value.map((p) => ({ label: String(p.name), value: String(p.name) }));
    const selectedName = await deps.prompt.select<string>({
      message: 'Select project to onboard',
      choices,
    });
    selectedProject = projectsResult.value.find((p) => String(p.name) === selectedName);
    if (selectedProject === undefined) throw new Error(`Project '${selectedName}' not found`);
  }
  if (selectedProject === undefined) throw new Error('No project selected');

  let repoPath: AbsolutePath | undefined;
  if (selectedProject.repositories.length === 1) {
    repoPath = selectedProject.repositories[0]?.path;
  } else if (selectedProject.repositories.length > 1) {
    const choices = selectedProject.repositories.map((r) => ({ label: `${r.name} — ${r.path}`, value: r.path }));
    const selected = await deps.prompt.select<string>({
      message: 'Select repository to onboard',
      choices,
    });
    const parsed = AbsolutePath.parse(selected);
    if (!parsed.ok) throw new Error('Invalid repository path');
    repoPath = parsed.value;
  }

  return {
    flow: 'onboard',
    projectName: selectedProject.name,
    autoAccept: false,
    ...(repoPath !== undefined ? { repoPath } : {}),
  };
}

/**
 * Main entry — build the appropriate inputs for the flow, start a session,
 * and return its id (or null if the user cancelled at a pre-flight prompt).
 */
export async function launchWorkflow(
  flow: ChainFlow,
  { deps, sessionManager, router }: LaunchOptions
): Promise<SessionId | null> {
  const inputs = await buildInputsForFlow(flow, deps, router);
  if (inputs === null) return null;
  return startFlowSession(deps, sessionManager, inputs);
}

function buildInputsForFlow(flow: ChainFlow, deps: SharedDeps, router: RouterApi): Promise<FlowInputs | null> {
  switch (flow) {
    case 'refine':
      return buildRefineInputs(deps, router);
    case 'plan':
      return buildPlanInputs(deps, router);
    case 'ideate':
      return buildIdeateInputs(deps, router);
    case 'execute':
      return buildExecuteInputs(deps, router);
    case 'feedback':
      return buildFeedbackInputs(deps, router);
    case 'create-pr':
      return buildCreatePrInputs(deps, router);
    case 'onboard':
      return buildOnboardInputs(deps);
  }
  const _exhaustive: never = flow;
  void _exhaustive;
  throw new Error('launchWorkflow: unreachable');
}
