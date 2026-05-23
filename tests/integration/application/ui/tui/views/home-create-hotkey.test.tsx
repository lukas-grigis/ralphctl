/**
 * Behavior 4 — Home `+` hotkey.
 *
 * Pressing `+` on Home when `hasProject === true` (a project is selected) MUST launch the
 * create-sprint flow. When no project is selected the key is a no-op (or shows a gating reason).
 *
 * NOTE: These tests will FAIL until the implementer lands the `+` hotkey on HomeView.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const noopVersionChecker = async (): Promise<null> => null;

const baseDeps = (overrides: Partial<AppDeps> = {}): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok([]);
      },
      async findById() {
        return Result.error(new NotFoundError({ entity: 'project', id: 'x', message: 'nope' }));
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([]);
      },
      async findById() {
        return Result.error(new NotFoundError({ entity: 'sprint', id: 'x', message: 'nope' }));
      },
    } as unknown as SprintRepository,
    sprintExecutionRepo: {
      async findById(id: unknown) {
        return Result.error(
          new NotFoundError({ entity: 'sprint-execution', id: String(id), message: 'no executions' })
        );
      },
    } as unknown as SprintExecutionRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    settingsRepo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
      async save() {
        return Result.ok(undefined);
      },
    } as unknown as SettingsRepository,
    versionChecker: noopVersionChecker,
    ...overrides,
  }) as unknown as AppDeps;

describe('HomeView — + hotkey', () => {
  it('routes to create-sprint when a project is selected and + is pressed', async () => {
    const project = makeProject({ displayName: 'Hotkey Project' });

    const projectRepo: ProjectRepository = {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository;

    const routedIds: string[] = [];

    const { result } = renderView(<HomeView />, {
      deps: baseDeps({ projectRepo }),
      initial: { id: 'home' },
      selection: { projectId: project.id, projectLabel: project.displayName },
      onRoute: (entry) => {
        routedIds.push(entry.id);
      },
    });

    await tick(500);

    // Press '+' — should launch create-sprint.
    result.stdin.write('+');
    await tick(100);

    // The router should have been asked to push the create-sprint execute view.
    // The implementer may route via 'execute' (after launching the runner) or navigate to
    // a dedicated create-sprint view. We assert the route changed away from 'home'.
    const lastRoute = routedIds[routedIds.length - 1];
    expect(lastRoute).toBeDefined();
    expect(lastRoute).not.toBe('home');

    result.unmount();
  });

  it('shows a gating reason or is a no-op when no project is selected and + is pressed', async () => {
    const routedIds: string[] = [];

    const { result } = renderView(<HomeView />, {
      deps: baseDeps(),
      initial: { id: 'home' },
      onRoute: (entry) => {
        routedIds.push(entry.id);
      },
    });

    await tick(500);

    // Before pressing + — record current route count.
    const countBefore = routedIds.length;

    result.stdin.write('+');
    await tick(100);

    // Without a project the + key MUST NOT launch create-sprint (no route change expected).
    const routedAfter = routedIds.slice(countBefore);
    // Either no new route, or the frame shows a gating message.
    const frame = result.lastFrame() ?? '';
    const hasGatingMessage = frame.match(/no project|pick a project|project.*required|select.*project/i) !== null;
    const routedToCreateSprint = routedAfter.some((id) => id === 'execute' || id === 'create-sprint');

    // Exactly one of these must be true: either there is a gating message OR there was no
    // routing to create-sprint. Both conditions together assert correct guarding behavior.
    expect(routedToCreateSprint).toBe(false);
    // The frame may show a gating reason OR the key is simply silent — both are acceptable.
    // We don't assert `hasGatingMessage` since silent is also valid per spec.
    void hasGatingMessage; // referenced to prevent unused-var lint

    result.unmount();
  });
});
