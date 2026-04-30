import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TicketAddView } from './ticket-add-view.tsx';
import { RouterProvider } from '../router-context.ts';
import { ViewHintsProvider } from '../view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../../bootstrap/shared-deps.ts';
import { FakePromptPort } from '../../../_test-fakes/fake-prompt-port.ts';
import { Sprint } from '../../../../domain/entities/sprint.ts';
import { Project } from '../../../../domain/entities/project.ts';
import { Repository } from '../../../../domain/entities/repository.ts';
import { Slug } from '../../../../domain/values/slug.ts';
import { ProjectName } from '../../../../domain/values/project-name.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../../domain/values/iso-timestamp.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '../../../config/config-defaults.ts';

function makeRouter() {
  return {
    current: { id: 'ticket-add' as const },
    stack: [{ id: 'home' as const }, { id: 'ticket-add' as const }],
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

function makeSprint() {
  const r = Sprint.create({ name: 'Test Sprint', slug: makeSlug('test'), now: IsoTimestamp.now() });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeProject(name: string) {
  const nameResult = ProjectName.parse(name);
  if (!nameResult.ok) throw new Error(nameResult.error.message);
  const pathResult = AbsolutePath.parse('/tmp/test-repo');
  if (!pathResult.ok) throw new Error(pathResult.error.message);
  const repoResult = Repository.create({ path: pathResult.value });
  if (!repoResult.ok) throw new Error(repoResult.error.message);
  const result = Project.create({ name: nameResult.value, displayName: name, repositories: [repoResult.value] });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

let fakePrompt: FakePromptPort;
const testSprint = makeSprint();
const testProject = makeProject('api-service');

beforeEach(() => {
  fakePrompt = new FakePromptPort();
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
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },
    sprintRepo: {
      findById: vi.fn(() => Promise.resolve(Result.ok(testSprint))),
      save: vi.fn((sprint: Sprint) => Promise.resolve(Result.ok(sprint))),
      list: vi.fn(),
      remove: vi.fn(),
    },
    projectRepo: {
      list: vi.fn(() => Promise.resolve(Result.ok([testProject]))),
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

describe('TicketAddView', () => {
  it('renders without crashing', async () => {
    fakePrompt.queueSelect(String(testProject.name));
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null); // skip description
    fakePrompt.queueInput(''); // no link

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows ADD TICKET header', async () => {
    fakePrompt.queueSelect(String(testProject.name));
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueInput('');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('ADD TICKET');
  });

  it('shows success card after adding ticket', async () => {
    fakePrompt.queueSelect(String(testProject.name));
    fakePrompt.queueInput('My Ticket');
    fakePrompt.queueEditor(null);
    fakePrompt.queueInput('');

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ticket added');
  });

  it('shows error when no current sprint', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: { findById: vi.fn(), save: vi.fn(), list: vi.fn(), remove: vi.fn() },
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
          <TicketAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Failed');
  });
});
