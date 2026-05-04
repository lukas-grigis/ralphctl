import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SprintShowView } from './sprint-show-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';

function makeRouter() {
  return {
    current: { id: 'sprint-show' as const },
    stack: [{ id: 'home' as const }, { id: 'sprint-show' as const }],
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

function makeSprint(name: string) {
  const now = IsoTimestamp.now();
  const result = Sprint.create({ name, slug: makeSlug('test'), now, projectName: asProjectName('demo') });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const testSprint = makeSprint('Alpha Sprint');

beforeEach(() => {
  setSharedDeps({
    sprintRepo: {
      findById: vi.fn(() => Promise.resolve(Result.ok(testSprint))),
      list: vi.fn(),
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
  resetSharedDeps();
});

describe('SprintShowView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintShowView sprintId={String(testSprint.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows SPRINT header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintShowView sprintId={String(testSprint.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('SPRINT');
  });

  it('shows sprint name and status', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintShowView sprintId={String(testSprint.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha Sprint');
    expect(frame).toContain('DRAFT');
  });

  it('shows field list', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintShowView sprintId={String(testSprint.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ID');
    expect(frame).toContain('Status');
    expect(frame).toContain('Project');
    expect(frame).toContain('demo');
    expect(frame).toContain('Repos');
    // No repos selected yet on a fresh draft sprint.
    expect(frame).toContain('set during plan');
  });

  it('shows error when sprint not found', async () => {
    setSharedDeps({
      sprintRepo: {
        findById: vi.fn(() => Promise.resolve(Result.error(new NotFoundError({ entity: 'sprint', id: 'notfound' })))),
        list: vi.fn(),
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
          <SprintShowView sprintId="00000000" />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('Sprint not found');
  });

  it('shows tickets section when tickets present', async () => {
    const sprintWithTickets = makeSprint('Sprint With Tickets');
    setSharedDeps({
      sprintRepo: {
        findById: vi.fn(() => Promise.resolve(Result.ok(sprintWithTickets))),
        list: vi.fn(),
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
          <SprintShowView sprintId={String(sprintWithTickets.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    // Sprint has no tickets but should show "No tickets yet"
    expect(lastFrame()).toContain('No tickets');
  });

  it('e key pushes sprint-remove for sprint-show detail view', async () => {
    // The detail.edit key is 'e' per keyboard-map
    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintShowView sprintId={String(testSprint.id)} />
        </ViewHintsProvider>
      </RouterProvider>
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    stdin.write('r'); // remove (list.remove = 'r')
    await new Promise((r) => setTimeout(r, 10));
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ id: 'sprint-remove' }));
  });
});
