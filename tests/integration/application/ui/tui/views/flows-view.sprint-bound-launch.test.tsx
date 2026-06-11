/**
 * Flows view — sprint-bound launch wiring.
 *
 * Launching `create-sprint` from the Flows menu must not pin the PREVIOUS selection's sprint
 * onto the new run's session descriptor: the run's sprint does not exist at launch time, and a
 * stale pin would mislabel the execute view / breadcrumb for the whole run. The project still
 * pins (the new sprint will belong to it). The real sprint is pinned later via the sprint-bound
 * wrapper's `onSprintResolved` — chain completion is not driven here (the create-sprint chain
 * parks on an interactive name prompt), so this test fences the launch-time descriptor only.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { FlowsView } from '@src/application/ui/tui/views/flows-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { ENTER, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const STALE_SPRINT_ID = 'stale-sprint-id' as unknown as SprintId;

const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [],
} as unknown as Project;

const staleSprint = {
  id: STALE_SPRINT_ID,
  projectId: PROJECT_ID,
  slug: 'stale-sprint',
  name: 'Stale Sprint',
  status: 'draft',
  tickets: [],
} as unknown as Sprint;

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const makeDeps = (): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([staleSprint]);
      },
      async findById() {
        return Result.ok(staleSprint);
      },
    } as unknown as SprintRepository,
    sprintExecutionRepo: {} as unknown as SprintExecutionRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    settingsRepo: {
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
    } as unknown as SettingsRepository,
    settings: DEFAULT_SETTINGS,
    eventBus: createInMemoryEventBus(),
    clock: () => Date.now(),
    logger: noopLogger,
    appendFile: async () => Result.ok(undefined),
    skillSource: { skillsFor: () => [] },
  }) as unknown as AppDeps;

describe('FlowsView — create-sprint launch does not pin the stale sprint', () => {
  it('registers the session with pinnedProjectId set and pinnedSprintId unset', async () => {
    const sessions = createSessionManager();
    const routedIds: string[] = [];

    const { result } = renderView(<FlowsView />, {
      deps: makeDeps(),
      initial: { id: 'flows' },
      sessions,
      selection: {
        projectId: PROJECT_ID,
        projectLabel: 'Fixture Project',
        sprintId: STALE_SPRINT_ID,
        sprintLabel: 'Stale Sprint',
      },
      onRoute: (entry) => {
        routedIds.push(entry.id);
      },
    });

    await waitForViewReady(result, (frame) => frame.includes('Create sprint'));

    // Walk the cursor down until the "Create sprint" row is focused, then launch it. The
    // bounded walk keeps the test robust against trigger-gating changes upstream in the menu.
    const focusedOnCreate = (): boolean => {
      const frame = result.lastFrame() ?? '';
      return new RegExp(`\\${glyphs.actionCursor}\\s+Create sprint`).test(frame);
    };
    for (let i = 0; i < 15 && !focusedOnCreate(); i += 1) {
      result.stdin.write('j');
      await tick(20);
    }
    expect(focusedOnCreate()).toBe(true);

    result.stdin.write(ENTER);
    await waitFor(() => sessions.list().some((s) => s.descriptor.flowId === 'create-sprint'), { timeoutMs: 3000 });

    const record = sessions.list().find((s) => s.descriptor.flowId === 'create-sprint');
    expect(record).toBeDefined();
    // Project pins; the stale sprint must NOT.
    expect(record?.descriptor.pinnedProjectId).toBe(PROJECT_ID);
    expect(record?.descriptor.pinnedSprintId).toBeUndefined();
    expect(record?.descriptor.pinnedSprintLabel).toBeUndefined();

    // The launch routed into the execute view.
    await waitFor(() => routedIds.includes('execute'));
    expect(routedIds).toContain('execute');
  });
});
