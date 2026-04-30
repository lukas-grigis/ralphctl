import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ProjectAddView } from './project-add-view.tsx';
import { RouterProvider } from '../router-context.ts';
import { ViewHintsProvider } from '../view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../../bootstrap/shared-deps.ts';
import { FakePromptPort } from '../../../_test-fakes/fake-prompt-port.ts';
import { Project } from '../../../../domain/entities/project.ts';
import { Repository } from '../../../../domain/entities/repository.ts';
import { ProjectName } from '../../../../domain/values/project-name.ts';
import { AbsolutePath } from '../../../../domain/values/absolute-path.ts';
import { Result } from 'typescript-result';
import { NotFoundError } from '../../../../domain/errors/not-found-error.ts';

function makeRouter() {
  return {
    current: { id: 'project-add' as const },
    stack: [{ id: 'home' as const }, { id: 'project-add' as const }],
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

let fakePrompt: FakePromptPort;

beforeEach(() => {
  fakePrompt = new FakePromptPort();
  setSharedDeps({
    projectRepo: {
      findByName: vi.fn(() => Promise.resolve(Result.error(new NotFoundError({ entity: 'project', id: 'test' })))),
      save: vi.fn(() => Promise.resolve(Result.ok(makeProject('test', 'Test')))),
      list: vi.fn(() => Promise.resolve(Result.ok([]))),
      remove: vi.fn(),
    },
    prompt: fakePrompt,
  } as unknown as SharedDeps);
});

afterEach(() => {
  resetSharedDeps();
});

describe('ProjectAddView', () => {
  it('renders without crashing', async () => {
    // Cancel immediately
    fakePrompt.queueInput(''); // No slug entered — throw
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows ADD PROJECT header', async () => {
    fakePrompt.queueInput('');
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('ADD PROJECT');
  });

  it('shows success card after successful creation', async () => {
    const createdProject = makeProject('my-app', 'My App');
    setSharedDeps({
      projectRepo: {
        findByName: vi.fn(() => Promise.resolve(Result.error(new NotFoundError({ entity: 'project', id: 'my-app' })))),
        save: vi.fn(() => Promise.resolve(Result.ok(createdProject))),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        remove: vi.fn(),
      },
      prompt: fakePrompt,
    } as unknown as SharedDeps);

    // Queue: slug, displayName, fileBrowser (repo path), checkScript (blank), description (blank)
    fakePrompt.queueInput('my-app');
    fakePrompt.queueInput('My App');
    fakePrompt.queueFileBrowser('/tmp/test-repo');
    fakePrompt.queueInput(''); // check script
    fakePrompt.queueInput(''); // description

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    // Should show success card
    expect(frame).toContain('Project created');
  });

  it('shows error card on failure', async () => {
    setSharedDeps({
      projectRepo: {
        findByName: vi.fn(() => Promise.resolve(Result.error(new NotFoundError({ entity: 'project', id: 'test' })))),
        save: vi.fn(() =>
          Promise.resolve(
            Result.error({
              message: 'DB error',
              code: 'storage-error',
            } as unknown as import('../../../../domain/errors/domain-error.ts').DomainError)
          )
        ),
        list: vi.fn(() => Promise.resolve(Result.ok([]))),
        remove: vi.fn(),
      },
      prompt: fakePrompt,
    } as unknown as SharedDeps);

    fakePrompt.queueInput('my-app');
    fakePrompt.queueInput('My App');
    fakePrompt.queueFileBrowser('/tmp/test-repo');
    fakePrompt.queueInput(''); // check script
    fakePrompt.queueInput(''); // description

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <ProjectAddView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Failed');
  });
});
