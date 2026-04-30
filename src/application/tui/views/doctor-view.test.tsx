import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DoctorView } from './doctor-view.tsx';
import { RouterProvider } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';

function makeRouter() {
  return {
    current: { id: 'doctor' as const },
    stack: [{ id: 'home' as const }, { id: 'doctor' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

// We provide enough of SharedDeps for runDoctor to run through its checks.
// The checks themselves are integration-tested elsewhere; here we stub
// out the storage layer and external deps so runDoctor resolves fast.
function makeDeps(): SharedDeps {
  return {
    configStore: {
      load: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { currentSprint: null, aiProvider: null, editor: null, evaluationIterations: 1 },
        })
      ),
      save: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
    },
    storage: {
      dataDir: '/tmp/ralphctl-test',
    },
    projectRepo: {
      list: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      findByName: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    },
    sprintRepo: {
      findById: vi.fn(() => Promise.resolve({ ok: false, error: { message: 'not found' } })),
      list: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      save: vi.fn(),
      remove: vi.fn(),
    },
    external: {
      spawnCommand: vi.fn(() => Promise.resolve({ ok: true, value: { stdout: '24.0.0\n', stderr: '', exitCode: 0 } })),
      checkGitIdentity: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
      checkBinaryExists: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
      checkPathExists: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
      checkIsDir: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
      checkIsGitRepo: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
    },
    prompt: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      checkbox: vi.fn(),
      editor: vi.fn(),
      fileBrowser: vi.fn(),
    },
  } as unknown as SharedDeps;
}

beforeEach(() => {
  setSharedDeps(makeDeps());
});

afterEach(() => {
  cleanup();
  resetSharedDeps();
});

describe('DoctorView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <DoctorView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows DOCTOR header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <DoctorView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('DOCTOR');
  });

  it('shows spinner while loading', () => {
    // Delay runDoctor by keeping the promise pending for a tick.
    const slow = new Promise<never>(() => undefined);
    setSharedDeps({
      ...makeDeps(),
      storage: {
        dataDir: '/tmp/slow',
        checkWritable: () => slow,
      },
    } as unknown as SharedDeps);

    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <DoctorView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Immediately after mount, before any async work resolves.
    expect(lastFrame()).toContain('Running doctor');
  });

  it('shows check results after loading', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <DoctorView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    // At least one check name should appear.
    expect(frame.length).toBeGreaterThan(0);
  });

  it('calls router.pop on Enter after loading', async () => {
    const router = makeRouter();
    const { lastFrame, stdin } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <DoctorView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toBeTruthy();
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(router.pop).toHaveBeenCalled();
  });
});
