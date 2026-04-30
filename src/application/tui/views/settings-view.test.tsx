import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SettingsView } from './settings-view.tsx';
import { RouterProvider } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { Result } from 'typescript-result';
import type { Config } from '../../config/config.ts';
import { CONFIG_DEFAULTS } from '../../config/config-defaults.ts';

function makeRouter() {
  return {
    current: { id: 'settings' as const },
    stack: [{ id: 'home' as const }, { id: 'settings' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeConfigStore(config: Config = CONFIG_DEFAULTS) {
  return {
    load: vi.fn(() => Promise.resolve(Result.ok(config))),
    save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
  };
}

beforeEach(() => {
  const configStore = makeConfigStore();
  setSharedDeps({
    configStore,
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

describe('SettingsView', () => {
  it('renders without crashing', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    // Give async config load a tick to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toBeTruthy();
  });

  it('shows the SETTINGS header', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('SETTINGS');
  });

  it('shows config keys from CONFIG_ROWS', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AI Provider');
    expect(frame).toContain('Eval Iterations');
    expect(frame).toContain('Log Level');
    // currentSprint is excluded from the settings panel
    expect(frame).not.toContain('Current Sprint');
  });

  it('shows (not set) for null values', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('(not set)');
  });

  it('shows default marker for default values', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('default');
  });

  it('shows cursor on first row initially', async () => {
    const router = makeRouter();
    const { lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <SettingsView />
        </ViewHintsProvider>
      </RouterProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    // First row should have the action cursor ▸
    expect(lastFrame()).toContain('▸');
  });
});
