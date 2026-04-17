/**
 * ViewRouter tests — verify the navigation stack semantics and global-hotkey
 * routing. We stub the three real views with marker components so a frame
 * snapshot tells us which view is on screen, and so the heavy data-loading
 * effects in HomeView/ExecuteView don't run during the test.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import type { PendingPrompt } from '@src/integration/prompts/prompt-queue.ts';

const currentPromptMock = vi.fn<() => PendingPrompt | null>(() => null);

vi.mock('@src/integration/prompts/hooks.ts', () => ({
  useCurrentPrompt: () => currentPromptMock(),
}));

vi.mock('./home-view.tsx', () => ({
  HomeView: () => <Text>HOME_VIEW</Text>,
}));

vi.mock('./settings-view.tsx', () => ({
  SettingsView: () => <Text>SETTINGS_VIEW</Text>,
}));

vi.mock('./execute-view.tsx', () => ({
  ExecuteView: () => <Text>EXECUTE_VIEW</Text>,
}));

vi.mock('./dashboard-view.tsx', () => ({
  DashboardView: () => <Text>DASHBOARD_VIEW</Text>,
}));

import { ViewRouter } from './view-router.tsx';
import type { ViewEntry } from './router-context.ts';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Ink defers single-byte ESC by ~20ms to disambiguate it from the start of
 * an escape sequence (arrow keys, etc.). Wait a bit longer so the pending
 * escape is flushed and useInput fires with `key.escape: true`.
 */
async function flushEscape(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();
}

describe('ViewRouter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    currentPromptMock.mockImplementation(() => null);
  });

  it('renders the home view when seeded with a single home entry', () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame } = render(<ViewRouter initialStack={initialStack} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('HOME_VIEW');
    expect(frame).toContain('Home');
  });

  it('renders the execute view when seeded with execute', () => {
    const initialStack: ViewEntry[] = [{ id: 'execute', props: { sprintId: 'sprint-1' } }];
    const { lastFrame } = render(<ViewRouter initialStack={initialStack} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('EXECUTE_VIEW');
    expect(frame).toContain('Execute');
  });

  it('pushes settings on top when the user presses `s`', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('s');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('SETTINGS_VIEW');
    expect(frame).not.toContain('HOME_VIEW');
    // Breadcrumb shows both frames.
    expect(frame).toContain('Home');
    expect(frame).toContain('Settings');
  });

  it('pops back to the previous view on Esc', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('s');
    await flush();
    expect(lastFrame() ?? '').toContain('SETTINGS_VIEW');

    stdin.write('\u001b'); // Esc
    await flushEscape();
    expect(lastFrame() ?? '').toContain('HOME_VIEW');
  });

  it('Esc at root is a no-op (stack stays at home)', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('\u001b');
    await flushEscape();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('HOME_VIEW');
    expect(frame).toContain('Home');
    // Breadcrumb still shows just Home (depth 1).
    expect(frame).not.toContain('Settings');
  });

  it('`h` resets the stack to a single home entry', async () => {
    const initialStack: ViewEntry[] = [{ id: 'execute', props: { sprintId: 'sprint-1' } }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('s'); // push settings on top of execute
    await flush();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('SETTINGS_VIEW');
    expect(frame).toContain('Execute');
    expect(frame).toContain('Settings');

    stdin.write('h');
    await flush();

    frame = lastFrame() ?? '';
    expect(frame).toContain('HOME_VIEW');
    expect(frame).not.toContain('SETTINGS_VIEW');
    expect(frame).not.toContain('EXECUTE_VIEW');
    // Breadcrumb collapsed to just Home.
    expect(frame).not.toContain('Execute');
  });

  it('does not stack settings on top of itself', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('s');
    await flush();
    stdin.write('s');
    await flush();

    // After two `s` presses, depth should still be 2 (home + settings) — Esc
    // should bring us back to home in one hop.
    stdin.write('\u001b');
    await flushEscape();
    expect(lastFrame() ?? '').toContain('HOME_VIEW');
  });

  it('pushes dashboard on top when the user presses `d`', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('d');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('DASHBOARD_VIEW');
    expect(frame).not.toContain('HOME_VIEW');
    expect(frame).toContain('Home');
    expect(frame).toContain('Dashboard');
  });

  it('pops back to home from dashboard on Esc', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('d');
    await flush();
    expect(lastFrame() ?? '').toContain('DASHBOARD_VIEW');

    stdin.write('\u001b');
    await flushEscape();
    expect(lastFrame() ?? '').toContain('HOME_VIEW');
  });

  it('does not stack dashboard on top of itself', async () => {
    const initialStack: ViewEntry[] = [{ id: 'home' }];
    const { lastFrame, stdin } = render(<ViewRouter initialStack={initialStack} />);

    stdin.write('d');
    await flush();
    stdin.write('d');
    await flush();

    // After two `d` presses, depth should still be 2 — single Esc returns home.
    stdin.write('\u001b');
    await flushEscape();
    expect(lastFrame() ?? '').toContain('HOME_VIEW');
  });

  describe('prompt-aware hotkey gating', () => {
    // When a prompt is active (e.g. user is typing a ticket title) the router
    // MUST NOT intercept plain characters like `s`/`d`/`h`/`q` or Esc — the
    // prompt's own input handler owns the keyboard until it resolves.
    // Regression: without this, typing "asdf" into an input prompt would push
    // settings, dashboard, and home on top of the prompt.

    const fakePrompt: PendingPrompt = {
      kind: 'input',
      options: { message: 'test' },
      resolve: vi.fn(),
      reject: vi.fn(),
    };

    it('does not push settings on `s` while a prompt is pending', async () => {
      currentPromptMock.mockImplementation(() => fakePrompt);
      const { lastFrame, stdin } = render(<ViewRouter initialStack={[{ id: 'home' }]} />);
      await flush();

      stdin.write('s');
      await flush();

      expect(lastFrame() ?? '').toContain('HOME_VIEW');
      expect(lastFrame() ?? '').not.toContain('SETTINGS_VIEW');
    });

    it('does not push dashboard on `d` while a prompt is pending', async () => {
      currentPromptMock.mockImplementation(() => fakePrompt);
      const { lastFrame, stdin } = render(<ViewRouter initialStack={[{ id: 'home' }]} />);
      await flush();

      stdin.write('d');
      await flush();

      expect(lastFrame() ?? '').toContain('HOME_VIEW');
      expect(lastFrame() ?? '').not.toContain('DASHBOARD_VIEW');
    });

    it('does not reset to home on `h` while a prompt is pending', async () => {
      currentPromptMock.mockImplementation(() => fakePrompt);
      const { lastFrame, stdin } = render(
        <ViewRouter initialStack={[{ id: 'home' }, { id: 'settings' }]} />
      );
      await flush();

      stdin.write('h');
      await flush();

      // Still on settings — `h` was eaten by the prompt, not the router.
      expect(lastFrame() ?? '').toContain('SETTINGS_VIEW');
    });

    it('does not pop on Esc while a prompt is pending', async () => {
      currentPromptMock.mockImplementation(() => fakePrompt);
      const { lastFrame, stdin } = render(
        <ViewRouter initialStack={[{ id: 'home' }, { id: 'settings' }]} />
      );
      await flush();

      stdin.write('\u001b');
      await flushEscape();

      // Still on settings — Esc belongs to the prompt (cancel the input).
      expect(lastFrame() ?? '').toContain('SETTINGS_VIEW');
    });

    it('hotkeys work normally when no prompt is pending', async () => {
      // currentPromptMock default is null — hotkeys should fire as usual.
      const { lastFrame, stdin } = render(<ViewRouter initialStack={[{ id: 'home' }]} />);
      await flush();

      stdin.write('s');
      await flush();
      expect(lastFrame() ?? '').toContain('SETTINGS_VIEW');
    });
  });
});
