import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { SprintListView } from './sprint-list-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';

function makeRouter() {
  return {
    current: { id: 'sprint-list' as const },
    stack: [{ id: 'home' as const }, { id: 'sprint-list' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function asProjectName(s: string) {
  const r = ProjectName.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint(name: string, status: 'draft' | 'active' | 'closed' = 'draft') {
  const now = IsoTimestamp.now();
  const result = Sprint.create({ name, slug: makeSlug('test'), now, projectName: asProjectName('demo') });
  if (!result.ok) throw new Error(result.error.message);
  let sprint = result.value;
  if (status === 'active') {
    const r = sprint.activate(now);
    if (r.ok) sprint = r.value;
  }
  if (status === 'closed') {
    const activated = sprint.activate(now);
    if (activated.ok) {
      const closed = activated.value.close(now);
      if (closed.ok) sprint = closed.value;
    }
  }
  return sprint;
}

beforeEach(() => {
  const sprints = [makeSprint('Sprint One', 'active'), makeSprint('Sprint Two', 'draft')];
  setSharedDeps({
    sprintRepo: {
      list: vi.fn(() => Promise.resolve(Result.ok(sprints))),
      findById: vi.fn(),
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

describe('SprintListView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows SPRINTS header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('SPRINTS');
  });

  it('shows sprint names after loading', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sprint One');
    expect(frame).toContain('Sprint Two');
  });

  it('shows status column', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTIVE');
  });

  it('navigates to sprint-show on Enter', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
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
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ id: 'sprint-show' }));
  });

  it('a key pushes sprint-create', async () => {
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith({ id: 'sprint-create' });
  });

  it('f key cycles filter and updates title', async () => {
    const router = makeRouter();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('f'); // cycle from 'all' → 'draft'
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? '';
    // Filter label is uppercase in the ViewShell title
    expect(frame.toLowerCase()).toContain('filter: draft');
  });

  it('shows empty state when no sprints', async () => {
    setSharedDeps({
      sprintRepo: {
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        findById: vi.fn(),
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
          <SprintListView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('No sprints');
  });
});
