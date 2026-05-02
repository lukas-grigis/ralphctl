/**
 * Basic HomeView smoke tests for the pipeline-map based home screen.
 *
 * The view requires async data loading before rendering content. Tests
 * inject shared deps via setSharedDeps and await a tick.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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
import { Result } from 'typescript-result';
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

function makeSprint(name = 'Test Sprint') {
  const pn = ProjectName.parse('demo');
  if (!pn.ok) throw new Error(pn.error.message);
  const r = Sprint.create({ name, slug: makeSlug('test'), now: IsoTimestamp.now(), projectName: pn.value });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function setMinimalDeps(currentSprint: string | null = null) {
  setSharedDeps({
    configStore: {
      load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint }))),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },
    sprintRepo: {
      findById: vi.fn(() => Promise.resolve(Result.error(new Error('not found')))),
      list: vi.fn(() => Promise.resolve(Result.ok([]))),
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
}

afterEach(() => {
  resetSharedDeps();
  vi.restoreAllMocks();
});

describe('HomeView', () => {
  it('renders without crashing — shows loading then content', async () => {
    setMinimalDeps();
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // First frame: spinner
    expect(lastFrame()).toBeTruthy();
    // After async load
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows the banner after loading', async () => {
    setMinimalDeps();
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    // Banner always renders the donut emoji and a Ralph quote inside a bordered box.
    expect(lastFrame()).toContain('🍩');
  });

  it('shows "No current sprint set" when no sprint configured', async () => {
    setMinimalDeps(null);
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('No current sprint set');
  });

  it('shows pipeline phase labels after loading', async () => {
    setMinimalDeps();
    const router = makeRouter();
    const sm = makeSessionManager();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    // Pipeline map should have phase rows
    expect(frame).toMatch(/Refine|Plan|Execute|Close|Create Sprint/);
  });

  it('opens browse submenu on b press', async () => {
    setMinimalDeps();
    const router = makeRouter();
    const sm = makeSessionManager();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('b');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    // Browse submenu should be visible (title is uppercased)
    expect(frame.toUpperCase()).toContain('BROWSE');
  });

  it('returns to pipeline map from submenu on Esc', async () => {
    setMinimalDeps();
    const router = makeRouter();
    const sm = makeSessionManager();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('b');
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('\x1B'); // Esc
    await new Promise((r) => setTimeout(r, 10));
    // Should be back to main (banner visible)
    expect(lastFrame()).toContain('🍩');
  });

  it('reloads home snapshot when the session manager emits an event', async () => {
    // Use configStore.load as a proxy for "loadHomeSnapshot fired" — it's
    // the first I/O call inside the loader.
    const configLoad = vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null })));
    setSharedDeps({
      configStore: {
        load: configLoad,
        save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
      },
      sprintRepo: {
        findById: vi.fn(() => Promise.resolve(Result.error(new Error('not found')))),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
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

    const router = makeRouter();

    // Capture the subscriber so we can fire a synthetic registry event.
    const captured: { fn: (() => void) | null } = { fn: null };
    const sm: SessionManagerPort = {
      start: vi.fn(),
      list: vi.fn(() => []),
      get: vi.fn(),
      foreground: vi.fn(() => Result.ok()),
      background: vi.fn(() => Result.ok()),
      kill: vi.fn(() => Result.ok()),
      get active() {
        return null;
      },
      subscribe: vi.fn((fn: () => void) => {
        captured.fn = fn;
        return () => {
          captured.fn = null;
        };
      }),
      dispose: vi.fn(),
    };

    render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    // Wait for mount-time load to settle.
    await new Promise((r) => setTimeout(r, 50));
    const loadsAfterMount = configLoad.mock.calls.length;
    expect(loadsAfterMount).toBeGreaterThanOrEqual(1);
    expect(captured.fn).not.toBeNull();

    // Fire a synthetic registry event — refreshHome should run again.
    captured.fn?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(configLoad.mock.calls.length).toBeGreaterThan(loadsAfterMount);
  });

  it('shows sprint name after loading when sprint is set', async () => {
    const sprint = makeSprint('Pipeline Sprint');
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: sprint.id }))),
        save: vi.fn(),
      },
      sprintRepo: {
        findById: vi.fn(() => Promise.resolve(Result.ok(sprint))),
        list: vi.fn(() => Promise.resolve(Result.ok([sprint]))),
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
    expect(lastFrame()).toContain('Pipeline Sprint');
  });
});
