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
import { makeProject } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
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

  it('windows a long list: shows the visible head and a "N more" overflow cue below', async () => {
    const projects = Array.from({ length: 6 }, (_, i) =>
      makeProject({ id: ProjectId.generate(), displayName: `Project ${String(i)}`, slug: `proj-${String(i)}` })
    );
    const { result } = renderView(<ProjectsView />, { deps: stubDeps(projects), initial: { id: 'projects' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // visibleRows = 4, so two projects spill past the window and the below-overflow cue appears.
    expect(frame).toContain(glyphs.moreBelow);
    expect(frame).toContain('2 more');
    expect(frame).toContain('6 project(s)');
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
    await tick(40);
    result.stdin.write('e');
    await tick(40);
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('Old Label');
    }
    queue.resolveHead('New Label');
    await tick(40);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]?.displayName).toBe('New Label');
    result.unmount();
  });
});
