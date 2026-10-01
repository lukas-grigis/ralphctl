/**
 * `useFlowLauncher` — the one launch path for every flow row: view route → repository picker →
 * customize picker → launch → session registration. Work's agenda and the `flows` alias both
 * go through it, so ↵ is never a blind launch.
 */

import { useCallback, useState } from 'react';
import { flowRegistry, type FlowEntry } from '@src/application/registry.ts';
import { evaluateTriggers } from '@src/application/registry-triggers.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useRouter, type RouterApi, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { openFlowSession } from '@src/application/ui/tui/runtime/open-flow-session.ts';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import {
  launchFlow,
  type LaunchExtras,
  type LauncherDeps,
  type LaunchResult,
} from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { runCustomizePicker } from '@src/application/ui/tui/views/flows-customize-picker.ts';
import {
  applySkillsRememberChoice,
  buildLaunchExtras,
  makeRebuildSkillCandidates,
  prefetchSkillCandidates,
} from '@src/application/ui/tui/views/flows-launch-extras.ts';
import { runRepositorySelection } from '@src/application/ui/tui/views/flows-repository-picker.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';

/** Flow id whose launch needs special sprint-rebinding handling. */
const CREATE_SPRINT_FLOW_ID = 'create-sprint';

/**
 * Use-case-shaped flows (no chain runner) that have a dedicated view. A table so the covered ids
 * read as data — the registry reachability fence derives {@link VIEW_ROUTED_FLOW_IDS} from it.
 */
const VIEW_ROUTES: Readonly<Record<string, (snapshot: AppStateSnapshot) => ViewEntry | undefined>> = {
  doctor: () => ({ id: 'doctor' }),
  settings: () => ({ id: 'settings' }),
  'add-ticket': (snapshot) =>
    snapshot.sprint ? { id: 'add-ticket', props: { sprintId: snapshot.sprint.id } } : undefined,
  'remove-ticket': (snapshot) =>
    snapshot.sprint ? { id: 'sprint-detail', props: { sprintId: snapshot.sprint.id } } : undefined,
  'export-context': () => ({ id: 'export-context' }),
  'export-requirements': () => ({ id: 'export-requirements' }),
  'create-pr': () => ({ id: 'create-pr' }),
};

/** @public — consumed by the registry reachability fence. */
export const VIEW_ROUTED_FLOW_IDS: readonly string[] = Object.keys(VIEW_ROUTES);

/**
 * The view a flow opens, or `undefined` when it launches a chain (or needs a sprint and none is
 * selected).
 *
 * @public — exported for the route-shape tests.
 */
export const viewRouteFor = (flowId: string, snapshot: AppStateSnapshot): ViewEntry | undefined =>
  VIEW_ROUTES[flowId]?.(snapshot);

export type Launchability = { readonly ok: true } | { readonly ok: false; readonly disabledReason: string };

/** Manifest-trigger check for one flow against a snapshot. */
export const flowLaunchability = (flowId: string, snapshot: AppStateSnapshot | undefined): Launchability => {
  if (snapshot === undefined) return { ok: false, disabledReason: 'still loading' };
  const entry = flowRegistry.find((e) => e.manifest.id === flowId);
  if (entry === undefined) return { ok: false, disabledReason: `unknown flow ${flowId}` };
  const evaluated = evaluateTriggers(entry.manifest.triggers, snapshot.triggerInputs);
  return evaluated.enabled ? { ok: true } : { ok: false, disabledReason: evaluated.reason };
};

interface RunFlowLaunchDeps {
  readonly selection: ReturnType<typeof useSelection>;
  readonly sessions: SessionManager;
}

/**
 * create-sprint and close-sprint change which sprint the user is on — they go through the
 * sprint-bound wrapper so the post-completion reseat happens in one place. create-sprint strips
 * the launch-time sprint from the snapshot: the new one doesn't exist yet, and pinning the old one
 * would mislabel every panel (`onSprintResolved` pins the real one).
 */
const runFlowLaunch = async (
  launcherDeps: LauncherDeps,
  entry: FlowEntry,
  snapshot: AppStateSnapshot,
  launchExtras: LaunchExtras,
  { selection, sessions }: RunFlowLaunchDeps
): Promise<LaunchResult> => {
  const sprintBound = entry.manifest.id === CREATE_SPRINT_FLOW_ID || entry.manifest.id === 'close-sprint';
  if (!sprintBound) return launchFlow(launcherDeps, entry.manifest.id, snapshot, launchExtras);

  const { sprint: _staleSprint, ...snapshotWithoutSprint } = snapshot;
  void _staleSprint;
  return launchSprintBoundFlow(
    launcherDeps,
    entry.manifest.id,
    entry.manifest.id === CREATE_SPRINT_FLOW_ID ? snapshotWithoutSprint : snapshot,
    {
      ...launchExtras,
      onReseat: ({ id, name, status }) => {
        if (entry.manifest.id === CREATE_SPRINT_FLOW_ID) {
          selection.setSprint(id, name, status);
          return;
        }
        // close-sprint: refresh the chip without replaying the switch toast; no-ops if the user
        // moved to another sprint mid-run.
        if (status !== undefined) selection.syncSprintStatus(id, status);
      },
      onSprintResolved: (runnerId, { id, name }) => {
        sessions.setPinnedSprint(runnerId, id, name);
      },
    }
  );
};

/**
 * Subscribe BEFORE `start()` so a synchronous completion isn't missed. Self-unsubscribes on every
 * terminal event — a dead listener pins the runner's closure scope (historically an OOM source).
 */
const attachRepositoryCapture = (runner: Runner<unknown>, ui: ReturnType<typeof useUiState>): void => {
  const unsubRepoCapture: () => void = runner.subscribe((event) => {
    if (event.type === 'failed' || event.type === 'aborted') {
      unsubRepoCapture();
      return;
    }
    if (event.type !== 'completed') return;
    const ctx = event.ctx as { readonly repository?: { readonly id: RepositoryId } };
    if (ctx.repository !== undefined) ui.setSessionRepositoryId(ctx.repository.id);
    unsubRepoCapture();
  });
};

interface LaunchCtx {
  readonly deps: AppDeps;
  readonly queue: PromptQueue;
  readonly storage: StoragePaths;
  readonly ui: ReturnType<typeof useUiState>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly sessions: SessionManager;
  readonly router: RouterApi;
  readonly reload: () => void;
  readonly setLaunchError: (message: string | undefined) => void;
}

/** route-check → repository selection → customize picker → launch → session registration. */
const launchEntry = async (entry: FlowEntry, snapshot: AppStateSnapshot, ctx: LaunchCtx): Promise<void> => {
  const { deps, queue, storage, ui, selection, sessions, router, reload, setLaunchError } = ctx;
  setLaunchError(undefined);

  const route = viewRouteFor(entry.manifest.id, snapshot);
  if (route !== undefined) {
    router.push(route);
    return;
  }

  const interactive = createInkInteractivePrompt(queue);
  const launcherDeps: LauncherDeps = { app: deps, interactive, storage, runInTerminal: getRunInTerminal() };

  // `deps.settings` is a boot-time snapshot; the on-disk repo is the source of truth after a
  // Settings write.
  const freshSettings = await deps.settingsRepo.load();
  const settings = freshSettings.ok ? freshSettings.value : deps.settings;

  // The session-pinned repo is a soft default, re-pickable every launch; single-repo projects and
  // non-repo flows return `skip`.
  const repoSelection = await runRepositorySelection({
    interactive,
    flowId: entry.manifest.id,
    flowTitle: entry.manifest.title,
    project: snapshot.project,
    pinnedRepositoryId: ui.sessionRepositoryId,
  });
  if (repoSelection.kind === 'cancel') return;
  const chosenRepositoryId = repoSelection.kind === 'selected' ? repoSelection.repositoryId : undefined;
  if (chosenRepositoryId !== undefined) ui.setSessionRepositoryId(chosenRepositoryId);

  const skillCandidates = await prefetchSkillCandidates(launcherDeps, snapshot, entry.manifest.id, settings);

  // AI flows get Start / Customize / Cancel; per-launch overrides travel in LaunchExtras and the
  // picker never mutates settings itself. Non-AI flows return `defaults` without prompting.
  const picker = await runCustomizePicker({
    interactive,
    flowId: entry.manifest.id,
    flowTitle: entry.manifest.title,
    settings,
    availableModelsFor: deps.availableModelsFor,
    // A degraded listing is withheld: a checklist over a partial set misreads as "disable the rest".
    ...(skillCandidates !== undefined && !skillCandidates.degraded ? { skillCandidates } : {}),
    rebuildSkillCandidates: makeRebuildSkillCandidates(launcherDeps, snapshot, entry.manifest.id, settings),
  });
  if (picker.kind === 'cancel') return;

  // Non-fatal: the run already carries the full override, so a save failure only loses the preference.
  const rememberError = await applySkillsRememberChoice(deps.settingsRepo, settings, skillCandidates, picker);
  if (rememberError !== undefined) {
    launcherDeps.app.logger.warn(rememberError);
    setLaunchError(rememberError);
  }

  const launchExtras = buildLaunchExtras(picker, entry, chosenRepositoryId, ui, settings);
  const result = await runFlowLaunch(launcherDeps, entry, snapshot, launchExtras, { selection, sessions });
  if (!result.ok) {
    setLaunchError(`${entry.manifest.title}: ${result.reason}`);
    return;
  }
  attachRepositoryCapture(result.runner, ui);
  // `replace` so the launching view isn't left on the stack behind the run.
  openFlowSession({ sessions, router }, result, entry.manifest.id, { mode: 'replace' });
  reload();
};

export interface UseFlowLauncherArgs {
  readonly snapshot: AppStateSnapshot | undefined;
  readonly reload: () => void;
}

export interface FlowLauncher {
  readonly launch: (flowId: string) => Promise<void>;
  readonly launchability: (flowId: string) => Launchability;
  readonly launchError: string | undefined;
}

export const useFlowLauncher = ({ snapshot, reload }: UseFlowLauncherArgs): FlowLauncher => {
  const ui = useUiState();
  const deps = useDeps();
  const selection = useSelection();
  const router = useRouter();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);

  const launch = useCallback(
    async (flowId: string): Promise<void> => {
      const entry = flowRegistry.find((e) => e.manifest.id === flowId);
      if (entry === undefined || snapshot === undefined) return;
      await launchEntry(entry, snapshot, {
        deps,
        queue,
        storage,
        ui,
        selection,
        sessions,
        router,
        reload,
        setLaunchError,
      });
    },
    [snapshot, deps, queue, storage, ui, selection, sessions, router, reload]
  );

  const launchability = useCallback((flowId: string): Launchability => flowLaunchability(flowId, snapshot), [snapshot]);

  return { launch, launchability, launchError };
};
