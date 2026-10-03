/**
 * AI-CLI pre-flight for the flows that used to skip it: Detect scripts, Detect skills and Review must
 * refuse at launch with the "not on PATH" reason — before any prompt — instead of failing on a spawn ENOENT.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { launchFlow, type LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type * as DetectCliModule from '@src/integration/system/detect-cli.ts';

const detectRef = vi.hoisted(() => ({ installed: new Set<string>() }));

vi.mock('@src/integration/system/detect-cli.ts', async () => {
  const actual = await vi.importActual<typeof DetectCliModule>('@src/integration/system/detect-cli.ts');
  return {
    ...actual,
    detectInstalledProviders: async (): Promise<ReadonlySet<AiProvider>> =>
      new Set(detectRef.installed) as ReadonlySet<AiProvider>,
  };
});

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
    operatorAgentDefinitionsRoot: absPath(cwd),
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

const askConfirmSpy = vi.fn(async (input: AskConfirmInput) => {
  void input;
  return Result.ok(false as boolean);
});

const makeDeps = (): LauncherDeps => ({
  app: makeAppDeps(),
  interactive: {
    askConfirm: askConfirmSpy,
  } as unknown as InteractivePrompt,
  storage: storage(),
  runInTerminal: passthroughRunInTerminal,
});

const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [{ id: 'repo-1', name: 'repo', path: absPath(process.cwd()) }],
} as unknown as Project;

const sprint = {
  id: SPRINT_ID,
  projectId: PROJECT_ID,
  slug: 'fixture-sprint',
  name: 'Fixture Sprint',
  status: 'review',
  tickets: [],
} as unknown as Sprint;

const snapshot: AppStateSnapshot = {
  project,
  sprint,
  tasks: [],
  triggerInputs: {
    hasProject: true,
    currentSprintStatus: 'review',
    pendingTicketCount: 0,
    approvedTicketCount: 0,
    resumableTaskCount: 0,
  },
  projectCount: 1,
  sprintCount: 1,
  recentSprints: [sprint],
};

describe('launchFlow — AI-CLI pre-flight', () => {
  beforeEach(() => {
    detectRef.installed = new Set();
    askConfirmSpy.mockClear();
  });

  it.each([['detect-scripts'], ['detect-skills'], ['review']])(
    '%s refuses with the not-on-PATH reason before any prompt when the CLI is missing',
    async (flowId) => {
      const result = await launchFlow(makeDeps(), flowId, snapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('not on PATH');
      expect(result.reason).toContain('claude');
      expect(askConfirmSpy).not.toHaveBeenCalled();
    }
  );

  it('review gets past the pre-flight to its distill confirm once the CLI is installed', async () => {
    detectRef.installed = new Set(['claude-code']);
    const result = await launchFlow(makeDeps(), 'review', snapshot);
    expect(askConfirmSpy).toHaveBeenCalledTimes(1);
    expect(askConfirmSpy.mock.calls[0]?.[0]).toMatchObject({ defaultValue: false });
    if (!result.ok) expect(result.reason).not.toContain('not on PATH');
  });
});
