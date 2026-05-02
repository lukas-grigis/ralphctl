import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ProjectListView } from './project-list-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Result } from 'typescript-result';

function makeRouter() {
  return {
    current: { id: 'project-list' as const },
    stack: [{ id: 'home' as const }, { id: 'project-list' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeProject(name: string, displayName: string) {
  const nameResult = ProjectName.parse(name);
  if (!nameResult.ok) throw new Error(nameResult.error.message);
  const pathResult = AbsolutePath.parse('/tmp/test-repo');
  if (!pathResult.ok) throw new Error(pathResult.error.message);
  const repoResult = Repository.create({ path: pathResult.value });
  if (!repoResult.ok) throw new Error(repoResult.error.message);
  const result = Project.create({ name: nameResult.value, displayName, repositories: [repoResult.value] });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const testProjects = [makeProject('api-service', 'API Service'), makeProject('web-app', 'Web App')];

beforeEach(() => {
  setSharedDeps({
    projectRepo: {
      list: vi.fn(() => Promise.resolve(Result.ok(testProjects))),
      findByName: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    },
    prompt: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      checkbox: vi.fn(),
      editor: vi.fn(),
      fileBrowser: vi.fn(),
    },
  } as unknown as SharedDeps);
});

afterEach(() => {
  cleanup();
  resetSharedDeps();
});

describe('ProjectListView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows PROJECTS header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('PROJECTS');
  });

  it('shows project names after loading', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('API Service');
    expect(frame).toContain('Web App');
  });

  it('navigates to project-show on Enter', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Wait for data to load, then press Enter. Multiple short ticks give Ink
    // room to mount ListView and wire up its useInput before the keystroke
    // arrives — a single long await skips the flush window and the keystroke
    // is dropped.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    stdin.write('\r');
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-show' }));
  });

  it('a key pushes project-add', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith({ id: 'project-add' });
  });

  it('r key pushes project-remove with highlighted project name', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    stdin.write('r');
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-remove' }));
  });

  it('shows empty state when no projects', async () => {
    setSharedDeps({
      projectRepo: {
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        findByName: vi.fn(),
        save: vi.fn(),
        remove: vi.fn(),
      },
      prompt: {
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
        checkbox: vi.fn(),
        editor: vi.fn(),
        fileBrowser: vi.fn(),
      },
    } as unknown as SharedDeps);
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('No projects');
  });
});
