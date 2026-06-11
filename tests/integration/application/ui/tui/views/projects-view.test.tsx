/**
 * Smoke tests for ProjectsView. Verifies the empty state when no projects exist, the
 * populated row + footer when one exists, and `c` pushes the create-project route.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ProjectsView } from '@src/application/ui/tui/views/projects-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

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
    await waitForViewReady(result, (f) => f.includes('No projects yet'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No projects yet');
    expect(frame).toContain('Press c to create');
    result.unmount();
  });

  it('renders one row per project with name + slug + repo count', async () => {
    const project = makeProject({ displayName: 'Demo Project', slug: 'demo-proj' });
    const { result } = renderView(<ProjectsView />, { deps: stubDeps([project]), initial: { id: 'projects' } });
    await waitForViewReady(result, (f) => f.includes('Demo Project'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Demo Project');
    expect(frame).toContain('demo-proj');
    expect(frame).toContain('1 project(s)');
    result.unmount();
  });

  it('windows a long list: shows the visible head and a "N more" overflow cue below', async () => {
    const projects = Array.from({ length: 6 }, (_, i) =>
      makeProject({ id: ProjectId.generate(), displayName: `Project ${String(i)}`, slug: `proj-${String(i)}` })
    );
    const { result } = renderView(<ProjectsView />, { deps: stubDeps(projects), initial: { id: 'projects' } });
    await waitForViewReady(result, (f) => f.includes('6 project(s)'));
    const frame = result.lastFrame() ?? '';
    // visibleRows = 4, so two projects spill past the window and the below-overflow cue appears.
    expect(frame).toContain(glyphs.moreBelow);
    expect(frame).toContain('2 more');
    expect(frame).toContain('6 project(s)');
    result.unmount();
  });

  // Only the first two repos render inline; the rest collapse into a "+N more repositor(y|ies)"
  // overflow line. The pluralization is by the overflow count (length - 2), not the total.
  const projectWithRepos = (count: number): Project =>
    makeProject({
      displayName: 'Multi Repo',
      slug: 'multi',
      repositories: Array.from({ length: count }, (_, i) =>
        makeRepository({ id: RepositoryId.generate(), name: `repo-${String(i)}`, path: `/tmp/repo-${String(i)}` })
      ),
    });

  it('overflow line reads singular "repository" when exactly one repo is hidden', async () => {
    // 3 repos → 2 shown, 1 hidden → "+1 more repository".
    const { result } = renderView(<ProjectsView />, {
      deps: stubDeps([projectWithRepos(3)]),
      initial: { id: 'projects' },
    });
    await waitForViewReady(result, (f) => f.includes('+1 more repository'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('+1 more repository');
    expect(frame).not.toContain('repositoryies');
    expect(frame).not.toContain('repositories');
    result.unmount();
  });

  it('overflow line reads plural "repositories" when more than one repo is hidden', async () => {
    // 4 repos → 2 shown, 2 hidden → "+2 more repositories".
    const { result } = renderView(<ProjectsView />, {
      deps: stubDeps([projectWithRepos(4)]),
      initial: { id: 'projects' },
    });
    await waitForViewReady(result, (f) => f.includes('+2 more repositories'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('+2 more repositories');
    expect(frame).not.toContain('repositoryies');
    result.unmount();
  });

  it('c pushes the create-project route', async () => {
    const { result, routeIds } = renderView(<ProjectsView />, { deps: stubDeps([]), initial: { id: 'projects' } });
    await waitForViewReady(result, (f) => f.includes('No projects yet'));
    result.stdin.write('c');
    await waitFor(() => routeIds().includes('create-project'));
    expect(routeIds()).toContain('create-project');
    result.unmount();
  });

  it("pressing 'e' opens a rename prompt and persists the new displayName", async () => {
    const project = makeProject({ displayName: 'Old Label' });
    const save = vi.fn(async (p: Project) => Result.ok<Project>(p));
    const repo = {
      async list() {
        return Result.ok([project] as readonly Project[]);
      },
      async findById() {
        return Result.ok(project);
      },
      save,
      async remove() {
        return Result.ok(undefined);
      },
    } as unknown as ProjectRepository;
    const queue = createPromptQueue();
    const deps = stubDeps([project]);
    (deps as unknown as { projectRepo: ProjectRepository }).projectRepo = repo;
    const { result } = renderView(<ProjectsView />, { deps, initial: { id: 'projects' }, queue });
    await waitForViewReady(result, (f) => f.includes('Old Label'));
    result.stdin.write('e');
    await waitFor(() => queue.head !== undefined);
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('Old Label');
    }
    queue.resolveHead('New Label');
    await waitFor(() => save.mock.calls.length > 0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]?.displayName).toBe('New Label');
    result.unmount();
  });
});
