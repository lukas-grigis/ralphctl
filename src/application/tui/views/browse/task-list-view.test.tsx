import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TaskListView } from './task-list-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint() {
  const pn = ProjectName.parse('demo');
  if (!pn.ok) throw new Error(pn.error.message);
  const r = Sprint.create({ name: 'Test', slug: makeSlug('test'), now: IsoTimestamp.now(), projectName: pn.value });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeTask(name: string, order: number) {
  const pathResult = AbsolutePath.parse('/tmp/project');
  if (!pathResult.ok) throw new Error(pathResult.error.message);
  const r = Task.create({ name, order, projectPath: pathResult.value, steps: [], verificationCriteria: [] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const testSprint = makeSprint();
const testTasks = [makeTask('Implement auth', 1), makeTask('Write tests', 2)];

beforeEach(() => {
  setSharedDeps({
    configStore: {
      load: vi.fn(() =>
        Promise.resolve(
          Result.ok({
            ...CONFIG_DEFAULTS,
            currentSprint: testSprint.id,
          })
        )
      ),
      save: vi.fn(),
    },
    taskRepo: {
      findBySprintId: vi.fn(() => Promise.resolve(Result.ok(testTasks))),
      findById: vi.fn(),
      update: vi.fn(),
      saveAll: vi.fn(),
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
  resetSharedDeps();
});

function makeRouter() {
  return {
    current: { id: 'task-list' as const },
    stack: [{ id: 'home' as const }, { id: 'task-list' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

describe('TaskListView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows TASKS header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('TASKS');
  });

  it('shows task names after loading', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Implement auth');
    expect(frame).toContain('Write tests');
  });

  it('shows empty state when no tasks', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: testSprint.id }))),
        save: vi.fn(),
      },
      taskRepo: {
        findBySprintId: vi.fn(() => Promise.resolve(Result.ok([]))),
        findById: vi.fn(),
        update: vi.fn(),
        saveAll: vi.fn(),
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
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('No tasks');
  });

  it('shows task detail when Enter pressed on a task', async () => {
    const router = makeRouter();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r'); // Enter on first task
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? '';
    // Should show task detail with the first task's info
    expect(frame).toContain('Implement auth');
  });

  it('a key pushes task-add', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith({ id: 'task-add' });
  });

  it('f key cycles filter', async () => {
    const router = makeRouter();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TaskListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('f'); // cycle from 'all' → 'todo'
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? '';
    // Filter label is uppercase in the ViewShell title
    expect(frame.toLowerCase()).toContain('todo');
  });
});
