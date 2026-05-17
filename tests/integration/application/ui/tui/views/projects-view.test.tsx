/**
 * Smoke tests for ProjectsView. Verifies the empty state when no projects exist, the
 * populated row + footer when one exists, and `c` pushes the create-project route.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ProjectsView } from '@src/application/ui/tui/views/projects-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeProjectRepo = (projects: readonly Project[]): ProjectRepository =>
  ({
    async list() {
      return Result.ok([...projects]);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as unknown as ProjectRepository;

const stubDeps = (projects: readonly Project[]): AppDeps =>
  ({
    projectRepo: fakeProjectRepo(projects),
    sprintRepo: {} as never,
    sprintExecutionRepo: {} as never,
    taskRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

describe('ProjectsView', () => {
  it('shows the empty state when no projects exist', async () => {
    const { result } = renderView(<ProjectsView />, { deps: stubDeps([]), initial: { id: 'projects' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No projects yet');
    expect(frame).toContain('Press c to create');
    result.unmount();
  });

  it('renders one row per project with name + slug + repo count', async () => {
    const project = makeProject({ displayName: 'Demo Project', slug: 'demo-proj' });
    const { result } = renderView(<ProjectsView />, { deps: stubDeps([project]), initial: { id: 'projects' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Demo Project');
    expect(frame).toContain('demo-proj');
    expect(frame).toContain('1 project(s)');
    result.unmount();
  });

  it('c pushes the create-project route', async () => {
    const { result, routeIds } = renderView(<ProjectsView />, { deps: stubDeps([]), initial: { id: 'projects' } });
    await tick(40);
    result.stdin.write('c');
    await tick();
    expect(routeIds()).toContain('create-project');
    result.unmount();
  });
});
