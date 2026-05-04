/**
 * Tests for the sprint summary line on HomeView (pipeline-map layout).
 *
 * The sprint summary is a one-line header above the pipeline map showing
 * sprint name, status, ticket/task counts, and branch (when set).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { HomeView } from './home-view.tsx';
import { RouterProvider } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from '@src/domain/result.ts';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';

function makeRouter() {
  return {
    current: { id: 'home' as const },
    stack: [{ id: 'home' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeSessionManager(): SessionManagerPort {
  return {
    start: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    foreground: vi.fn(() => Result.ok()),
    background: vi.fn(() => Result.ok()),
    kill: vi.fn(() => Result.ok()),
    get active() {
      return null;
    },
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint(name: string) {
  const pn = ProjectName.parse('demo');
  if (!pn.ok) throw new Error(pn.error.message);
  const r = Sprint.create({ name, slug: makeSlug('test'), now: IsoTimestamp.now(), projectName: pn.value });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const testSprint = makeSprint('Beta Sprint');

describe('HomeView — sprint summary', () => {
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
      sprintRepo: {
        findById: vi.fn(() => Promise.resolve(Result.ok(testSprint))),
        list: vi.fn(() => Promise.resolve(Result.ok([testSprint]))),
        save: vi.fn(),
        remove: vi.fn(),
      },
      taskRepo: {
        findBySprintId: vi.fn(() => Promise.resolve(Result.ok([]))),
        findById: vi.fn(),
        update: vi.fn(),
        saveAll: vi.fn(),
      },
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
      sessionManager: {
        start: vi.fn(),
        list: vi.fn(() => []),
        get: vi.fn(),
        foreground: vi.fn(() => Result.ok()),
        background: vi.fn(() => Result.ok()),
        kill: vi.fn(() => Result.ok()),
        get active() {
          return null;
        },
        subscribe: vi.fn(() => () => undefined),
        dispose: vi.fn(),
      },
    } as unknown as SharedDeps);
  });

  afterEach(() => {
    resetSharedDeps();
  });

  it('shows sprint name in summary line', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain('Beta Sprint');
  });

  it('shows sprint status chip', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DRAFT');
  });

  it('shows "No current sprint set" when config has no sprint', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: {
        findById: vi.fn(),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        save: vi.fn(),
        remove: vi.fn(),
      },
      taskRepo: { findBySprintId: vi.fn(), findById: vi.fn(), update: vi.fn(), saveAll: vi.fn() },
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
      sessionManager: {
        start: vi.fn(),
        list: vi.fn(() => []),
        get: vi.fn(),
        foreground: vi.fn(() => Result.ok()),
        background: vi.fn(() => Result.ok()),
        kill: vi.fn(() => Result.ok()),
        get active() {
          return null;
        },
        subscribe: vi.fn(() => () => undefined),
        dispose: vi.fn(),
      },
    } as unknown as SharedDeps);

    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain('No current sprint set');
  });
});

describe('HomeView — pipeline-map rendered', () => {
  beforeEach(() => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: {
        findById: vi.fn(),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        save: vi.fn(),
        remove: vi.fn(),
      },
      taskRepo: { findBySprintId: vi.fn(), findById: vi.fn(), update: vi.fn(), saveAll: vi.fn() },
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
      sessionManager: {
        start: vi.fn(),
        list: vi.fn(() => []),
        get: vi.fn(),
        foreground: vi.fn(() => Result.ok()),
        background: vi.fn(() => Result.ok()),
        kill: vi.fn(() => Result.ok()),
        get active() {
          return null;
        },
        subscribe: vi.fn(() => () => undefined),
        dispose: vi.fn(),
      },
    } as unknown as SharedDeps);
  });

  afterEach(() => {
    resetSharedDeps();
  });

  it('shows pipeline phase Refine after loading', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain('Refine');
  });

  it('shows "Add Project" quick action when no sprint and no projects', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    // No projects → pipeline first action is "Add Project", not "Create Sprint".
    expect(frame).toContain('Add Project');
  });

  it('pressing Enter on the quick action navigates to project-add when no projects', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Wait for the pipeline map to finish rendering with the cursor on the
    // quick-action row. `▸` only appears once the cursor has been initialized
    // AND the PipelineMap's useInput handler is registered.
    await vi.waitFor(() => {
      const f = lastFrame() ?? '';
      expect(f).toContain('Add Project');
      expect(f).toContain('▸');
    });
    // Drain the microtask/macrotask queues so Ink's useInput subscription is
    // fully active before we send the keystroke (same technique used in
    // pipeline-map.test.tsx's flush() helper).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stdin.write('\r'); // Enter on "Add Project" quick action
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith({ id: 'project-add' });
    });
  });

  it('shows "Create Sprint" quick action when projects exist but no sprint', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: {
        findById: vi.fn(),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        save: vi.fn(),
        remove: vi.fn(),
      },
      taskRepo: { findBySprintId: vi.fn(), findById: vi.fn(), update: vi.fn(), saveAll: vi.fn() },
      projectRepo: {
        list: vi.fn(() => Promise.resolve(Result.ok([{ name: 'test', displayName: 'Test', repositories: [] }]))),
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
      sessionManager: {
        start: vi.fn(),
        list: vi.fn(() => []),
        get: vi.fn(),
        foreground: vi.fn(() => Result.ok()),
        background: vi.fn(() => Result.ok()),
        kill: vi.fn(() => Result.ok()),
        get active() {
          return null;
        },
        subscribe: vi.fn(() => () => undefined),
        dispose: vi.fn(),
      },
    } as unknown as SharedDeps);

    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Create Sprint');
  });

  it('b key opens browse submenu', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('b');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()?.toUpperCase()).toContain('BROWSE');
  });

  it('in browse submenu, Sprints drills into the sprint submenu (List → sprint-list)', async () => {
    const router = makeRouter();
    const sm = makeSessionManager();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 80));
    // Open browse submenu (b) → cursor lands on first selectable = "Sprints"
    // (no current sprint disables Tickets/Tasks). Pressing Enter drills into
    // the sprint submenu (subMenu drill-in, not direct route).
    stdin.write('b');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    // Now in the sprint submenu — its title (e.g. "SPRINT") is rendered.
    expect(lastFrame()?.toUpperCase()).toContain('SPRINT');
    // Drilling does NOT push a router view — it switches the in-view submenu.
    expect(router.push).not.toHaveBeenCalled();
  });
});
