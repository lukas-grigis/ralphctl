/**
 * Launch-time sprint pinning — `launchFlow` stamps the snapshot's project + sprint onto the
 * LaunchResult so the session descriptor can identify the run independently of the mutable
 * global selection.
 *
 * The one exception is `create-sprint`: its sprint does not exist at launch time, so any
 * sprint on the snapshot is by definition the PREVIOUS selection. Pinning that would
 * mislabel the run's execute view / breadcrumb; the sprint-bound launch wrapper pins the
 * real one via `setPinnedSprint` once the chain resolves it. These tests fence the guard.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
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
  };
};

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Minimal AppDeps for chain CONSTRUCTION only — the runner is never started, so the stubs
 * exist purely to satisfy the flow factories' dependency shapes.
 */
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
  interactive: {} as InteractivePrompt,
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

describe('launchFlow — pinned project/sprint stamping', () => {
  it('pins the snapshot sprint for a regular sprint-scoped flow (refine)', async () => {
    const result = await launchFlow(makeDeps(), 'refine', snapshot);
    if (!result.ok) throw new Error(`launch failed: ${result.reason}`);

    expect(result.pinnedProjectId).toBe(PROJECT_ID);
    expect(result.pinnedProjectLabel).toBe('Fixture Project');
    expect(result.pinnedSprintId).toBe(SPRINT_ID);
    expect(result.pinnedSprintLabel).toBe('Fixture Sprint');
  });

  it('does NOT pin the (stale) snapshot sprint for create-sprint', async () => {
    const result = await launchFlow(makeDeps(), 'create-sprint', snapshot);
    if (!result.ok) throw new Error(`launch failed: ${result.reason}`);

    // Project still pins — the new sprint will belong to it.
    expect(result.pinnedProjectId).toBe(PROJECT_ID);
    // The previous selection's sprint must NOT be pinned onto the new run.
    expect(result.pinnedSprintId).toBeUndefined();
    expect(result.pinnedSprintLabel).toBeUndefined();
  });
});
