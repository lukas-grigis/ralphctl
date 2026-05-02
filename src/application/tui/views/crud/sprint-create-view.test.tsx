import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SprintCreateView } from './sprint-create-view.tsx';
import { RouterProvider } from '@src/application/tui/views/router-context.ts';
import { ViewHintsProvider } from '@src/application/tui/views/view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';

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

function asProjectName(s: string) {
  const r = ProjectName.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint(name: string) {
  const r = Sprint.create({
    name,
    slug: makeSlug('test-sprint'),
    now: IsoTimestamp.now(),
    projectName: asProjectName('test-project'),
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const FAKE_PROJECT = {
  name: asProjectName('test-project'),
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
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(true);

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
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(true);

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
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(true);

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
            } as unknown as DomainError)
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

    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(true);

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
    // Queue: project select, then empty name (invalid), then valid name, then valid slug.
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('');
    fakePrompt.queueInput('My Sprint');
    fakePrompt.queueInput('my-sprint');
    fakePrompt.queueConfirm(true);

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
    // Queue: project select, then valid name, then invalid slug (spaces), then valid slug.
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('My Sprint');
    fakePrompt.queueInput('invalid slug with spaces');
    fakePrompt.queueInput('my-sprint');
    fakePrompt.queueConfirm(true);

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

  it('calls router.reset to Home when Enter is pressed after success with setAsCurrent=true', async () => {
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(true); // setAsCurrent = true

    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 150));
    // Simulate Enter in terminal state
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(router.reset).toHaveBeenCalledWith({ id: 'home' });
    expect(router.pop).not.toHaveBeenCalled();
  });

  it('calls router.pop when Enter is pressed after success with setAsCurrent=false', async () => {
    fakePrompt.queueSelect('test-project');
    fakePrompt.queueInput('Test Sprint');
    fakePrompt.queueInput('test-sprint');
    fakePrompt.queueConfirm(false); // setAsCurrent = false

    const router = makeRouter();
    const { stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SprintCreateView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 150));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(router.pop).toHaveBeenCalled();
    expect(router.reset).not.toHaveBeenCalled();
  });
});
