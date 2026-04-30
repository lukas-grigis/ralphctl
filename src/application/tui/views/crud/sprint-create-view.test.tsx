import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SprintCreateView } from './sprint-create-view.tsx';
import { RouterProvider } from '../router-context.ts';
import { ViewHintsProvider } from '../view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../../bootstrap/shared-deps.ts';
import { FakePromptPort } from '../../../_test-fakes/fake-prompt-port.ts';
import { Sprint } from '../../../../domain/entities/sprint.ts';
import { Slug } from '../../../../domain/values/slug.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '../../../config/config-defaults.ts';

function makeRouter() {
  return {
    current: { id: 'sprint-create' as const },
    stack: [{ id: 'home' as const }, { id: 'sprint-create' as const }],
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

function makeSprint(name: string) {
  const r = Sprint.create({ name, slug: makeSlug('test-sprint'), now: IsoTimestamp.now() });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const FAKE_PROJECT = {
  name: 'test-project',
  displayName: 'Test Project',
  repositories: [],
};

let fakePrompt: FakePromptPort;

beforeEach(() => {
  fakePrompt = new FakePromptPort();
  const sprint = makeSprint('Test Sprint');
  setSharedDeps({
    configStore: {
      load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },
    sprintRepo: {
      save: vi.fn(() => Promise.resolve(Result.ok(sprint))),
      findById: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
    },
    projectRepo: {
      list: vi.fn(() => Promise.resolve(Result.ok([FAKE_PROJECT]))),
      findByName: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    },
    prompt: fakePrompt,
  } as unknown as SharedDeps);
});

afterEach(() => {
  resetSharedDeps();
});

describe('SprintCreateView', () => {
  it('renders without crashing', async () => {
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows CREATE SPRINT header', async () => {
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('CREATE SPRINT');
  });

  it('shows success card after successful sprint creation', async () => {
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sprint created');
  });

  it('shows error card when sprint creation fails', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
      },
      sprintRepo: {
        save: vi.fn(() =>
          Promise.resolve(
            Result.error({
              message: 'storage error',
            } as unknown as import('../../../../domain/errors/domain-error.ts').DomainError)
          )
        ),
        findById: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
      },
      projectRepo: {
        list: vi.fn(() => Promise.resolve(Result.ok([FAKE_PROJECT]))),
        findByName: vi.fn(),
        save: vi.fn(),
        remove: vi.fn(),
      },
      prompt: fakePrompt,
    } as unknown as SharedDeps);

    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Failed');
  });

  it('shows no-projects warning when no projects exist', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
      },
      sprintRepo: {
        save: vi.fn(),
        findById: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
      },
      projectRepo: {
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        findByName: vi.fn(),
        save: vi.fn(),
        remove: vi.fn(),
      },
      prompt: fakePrompt,
    } as unknown as SharedDeps);

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No projects');
  });

  it('retries when empty name is entered, then succeeds on valid name', async () => {
    // Queue: empty string (invalid), then valid name, then valid slug.
    fakePrompt.queueInput('');
    fakePrompt.queueInput('My Sprint');
    fakePrompt.queueInput('my-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? '';
    // Should eventually succeed (not stuck in error state).
    expect(frame).toContain('Sprint created');
  });

  it('retries when invalid slug is entered, then succeeds on valid slug', async () => {
    // Queue: valid name, then invalid slug (spaces), then valid slug.
    fakePrompt.queueInput('My Sprint');
    fakePrompt.queueInput('invalid slug with spaces');
    fakePrompt.queueInput('my-sprint');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sprint created');
  });
});
