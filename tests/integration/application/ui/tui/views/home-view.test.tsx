/**
 * Smoke tests for HomeView. Three regimes: no project (empty state + create-project CTA),
 * project + sprint loaded (state card + Next-steps suggestions), and the action-menu surfaces.
 *
 * The Update / Doctor banners depend on async network + shell work; we leave them off the
 * critical path by stubbing the doctor probes with a no-op (everything passes) and pointing
 * the version checker at a noop adapter.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { VersionChecker } from '@src/business/version/version-checker.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const noopVersionChecker: VersionChecker = async () => null;

const baseDeps = (overrides: Partial<AppDeps>): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok([]);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([]);
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

describe('HomeView', () => {
  it('shows the create-project CTA when no projects exist', async () => {
    const { result } = renderView(<HomeView />, { deps: baseDeps({}), initial: { id: 'home' } });
    // Doctor probes shell out, so allow time before reading the frame.
    await tick(2500);
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/Start by creating a project/);
    expect(frame).toMatch(/create your first project/);
    result.unmount();
  });

  it('shows the sprint-creation CTA when a project is selected but no sprint', async () => {
    const project = makeProject({ displayName: 'Mainline' });
    const projectRepo = {
      async list() {
        return Result.ok({ items: [project], hasMore: false });
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository;
    const { result } = renderView(<HomeView />, {
      deps: baseDeps({ projectRepo }),
      initial: { id: 'home' },
      selection: { projectId: project.id, projectLabel: project.displayName },
    });
    await tick(2500);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Mainline');
    expect(frame).toMatch(/sprint/i);
    expect(frame).toMatch(/open Sprints/);
    result.unmount();
  });
});
