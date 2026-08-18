/**
 * Registry reachability fence — every `FlowManifest` in `flowRegistry` must be reachable by a
 * user, and every reachable id must resolve to something that runs.
 *
 * The bug this fences (issue #298): `add-ticket` was registered but appeared in none of the
 * Flows-menu visibility lists, so its row was filtered out even under the `v` show-all toggle —
 * and `viewRouteFor` had no case for it, so a hypothetical selection would have fallen through
 * to `launchFlow`'s `Unknown flow: add-ticket`. A dead registry entry is invisible in review;
 * these two directions make it fail CI instead.
 *
 *   forward  — every registry id is menu-visible (some visibility list) OR view-routed.
 *   backward — every menu-visible id has a view route OR a `launchFlow` dispatch case, and
 *              every view-routed id is actually in the registry.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { flowRegistry } from '@src/application/registry.ts';
import {
  HIDDEN_BY_DEFAULT_FLOW_IDS,
  PROJECT_SCOPED_FLOW_IDS,
  SPRINT_SCOPED_FLOW_IDS,
} from '@src/application/ui/tui/views/flows-visibility.ts';
import { VIEW_ROUTED_FLOW_IDS } from '@src/application/ui/tui/views/flows-view.tsx';
import { launchFlow, type LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

const PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const REGISTRY_IDS: readonly string[] = flowRegistry.map((entry) => entry.manifest.id);
const MENU_VISIBLE_IDS: readonly string[] = [
  ...PROJECT_SCOPED_FLOW_IDS,
  ...SPRINT_SCOPED_FLOW_IDS,
  ...HIDDEN_BY_DEFAULT_FLOW_IDS,
];
const ROUTED: ReadonlySet<string> = new Set(VIEW_ROUTED_FLOW_IDS);

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`bad path: ${p}`);
  return r.value;
};

const storage = (): StoragePaths => {
  const cwd = process.cwd();
  return {
    appRoot: absPath(cwd),
    dataRoot: absPath(cwd),
    configRoot: absPath(cwd),
    stateRoot: absPath(cwd),
    locksRoot: absPath(cwd),
    runsRoot: absPath(cwd),
    memoryRoot: absPath(cwd),
    operatorSkillsRoot: absPath(cwd),
    operatorAgentDefinitionsRoot: absPath(cwd),
  };
};

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Minimal AppDeps for chain CONSTRUCTION only — no runner is ever started. */
const makeAppDeps = (): AppDeps =>
  ({
    settings: DEFAULT_SETTINGS,
    settingsRepo: {
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
    },
    eventBus: createInMemoryEventBus(),
    clock: () => Date.now(),
    logger: noopLogger,
    projectRepo: {},
    sprintRepo: {},
    sprintExecutionRepo: {},
    taskRepo: {},
    appendFile: async () => Result.ok(undefined),
    skillSource: { skillsFor: () => [] },
  }) as unknown as AppDeps;

const makeDeps = (): LauncherDeps => ({
  app: makeAppDeps(),
  interactive: {
    // close-sprint asks for confirmation at launch time; returning true lets construction proceed.
    askConfirm: async () => Result.ok(true as boolean),
  } as unknown as InteractivePrompt,
  storage: storage(),
  runInTerminal: passthroughRunInTerminal,
});

const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [],
} as unknown as Project;

const sprint = {
  id: SPRINT_ID,
  projectId: PROJECT_ID,
  slug: 'fixture-sprint',
  name: 'Fixture Sprint',
  status: 'draft',
  tickets: [],
} as unknown as Sprint;

const snapshot: AppStateSnapshot = {
  project,
  sprint,
  tasks: [],
  triggerInputs: {
    hasProject: true,
    currentSprintStatus: 'draft',
    pendingTicketCount: 0,
    approvedTicketCount: 0,
    resumableTaskCount: 0,
  },
  projectCount: 1,
  sprintCount: 1,
  recentSprints: [sprint],
};

describe('flow registry reachability', () => {
  it.each(REGISTRY_IDS.map((id) => [id]))('registered flow %s is reachable — menu-visible or view-routed', (flowId) => {
    const reachable = MENU_VISIBLE_IDS.includes(flowId) || ROUTED.has(flowId);
    expect(
      reachable,
      `${flowId} is registered but neither listed in flows-visibility.ts nor routed by flows-view.tsx — ` +
        'it can never be shown or selected. Add it to a visibility list (and/or VIEW_ROUTES) or drop the entry.'
    ).toBe(true);
  });

  it.each(VIEW_ROUTED_FLOW_IDS.map((id) => [id]))('view-routed flow %s exists in the registry', (flowId) => {
    expect(REGISTRY_IDS).toContain(flowId);
  });

  it('every menu-visible flow id exists in the registry', () => {
    for (const id of MENU_VISIBLE_IDS) expect(REGISTRY_IDS).toContain(id);
  });

  it('every menu-visible flow without a view route is dispatchable by launchFlow', async () => {
    for (const flowId of MENU_VISIBLE_IDS) {
      if (ROUTED.has(flowId)) continue;
      // Only the dispatch arm matters: a flow may legitimately refuse to launch against this
      // bare fixture snapshot (no tickets / tasks / repositories), but it must never fall
      // through to the switch's `Unknown flow` default.
      const result = await launchFlow(makeDeps(), flowId, snapshot);
      if (!result.ok) {
        expect(result.reason, `${flowId} has no dispatch case in launchFlow`).not.toContain('Unknown flow');
      }
    }
  });
});
