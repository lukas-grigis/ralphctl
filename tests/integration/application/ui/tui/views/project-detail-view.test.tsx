/**
 * Smoke tests for ProjectDetailView. Renders the project info card + each repo as a
 * focusable card. `a` pushes the add-repository wizard.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ProjectDetailView } from '@src/application/ui/tui/views/project-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById() {
      return Result.ok(project);
    },
    async save() {
      return Result.ok(undefined);
    },
  }) as unknown as ProjectRepository;

const stubDeps = (project: Project): AppDeps =>
  ({
    projectRepo: fakeProjectRepo(project),
  }) as unknown as AppDeps;

describe('ProjectDetailView', () => {
  it('renders the project name + slug + repository roster', async () => {
    const project = makeProject({ displayName: 'Mainline', slug: 'mainline' });
    const { result } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Mainline');
    expect(frame).toContain('mainline');
    expect(frame).toContain('main-repo');
    expect(frame).toContain('Repositories');
    result.unmount();
  });

  it('a pushes the add-repository wizard scoped to this project', async () => {
    const project = makeProject({});
    const { result, routeIds } = renderView(<ProjectDetailView />, {
      deps: stubDeps(project),
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await tick(40);
    result.stdin.write('a');
    await tick();
    expect(routeIds()).toContain('add-repository');
    result.unmount();
  });
});
