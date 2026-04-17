/**
 * OnboardingView tests — mock the prompt port + persistence so the wizard
 * can be driven deterministically through its three steps.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { AiProvider } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi, type ViewEntry } from './router-context.ts';

const confirmMock = vi.fn<(opts: { message: string; default?: boolean }) => Promise<boolean>>();
const selectMock = vi.fn<(opts: { message: string; choices: unknown[] }) => Promise<string>>();
const setAiProviderMock = vi.fn<(provider: AiProvider) => Promise<void>>();

vi.mock('@src/application/bootstrap.ts', () => ({
  getPrompt: () => ({
    confirm: (opts: { message: string; default?: boolean }) => confirmMock(opts),
    select: (opts: { message: string; choices: unknown[] }) => selectMock(opts),
  }),
}));

vi.mock('@src/integration/persistence/config.ts', () => ({
  setAiProvider: (provider: AiProvider) => setAiProviderMock(provider),
}));

import { OnboardingView } from './onboarding-view.tsx';

const routerMocks = {
  push: vi.fn<(entry: ViewEntry) => void>(),
  pop: vi.fn<() => void>(),
  replace: vi.fn<(entry: ViewEntry) => void>(),
  reset: vi.fn<(entry: ViewEntry) => void>(),
};

const routerStub: RouterApi = {
  current: { id: 'onboarding' },
  stack: [{ id: 'onboarding' }],
  push: routerMocks.push,
  pop: routerMocks.pop,
  replace: routerMocks.replace,
  reset: routerMocks.reset,
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={routerStub}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('OnboardingView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Welcome title and a skip affordance on mount', async () => {
    // Block on the first prompt so the view stays in its initial running state.
    confirmMock.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves — holds the view on its initial running phase */
        })
    );
    const { lastFrame } = render(withRouter(<OnboardingView />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('WELCOME');
    // Intro prompt is fired by the workflow's run() — confirm it reached the
    // prompt layer (indirect assertion of the "skippable" affordance).
    expect(confirmMock).toHaveBeenCalled();
  });

  it('saves the selected provider and shows the done screen', async () => {
    confirmMock.mockResolvedValueOnce(true); // intro
    confirmMock.mockResolvedValueOnce(false); // don't add project
    selectMock.mockResolvedValueOnce('claude');
    setAiProviderMock.mockResolvedValue(undefined);

    const { lastFrame } = render(withRouter(<OnboardingView />));
    await flush();
    await flush();

    expect(setAiProviderMock).toHaveBeenCalledWith('claude');
    const frame = lastFrame() ?? '';
    expect(frame).toContain("You're set up");
    expect(frame).toContain('Claude Code');
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('skips provider save when the user picks "skip"', async () => {
    confirmMock.mockResolvedValueOnce(true);
    confirmMock.mockResolvedValueOnce(false);
    selectMock.mockResolvedValueOnce('skip');

    const { lastFrame } = render(withRouter(<OnboardingView />));
    await flush();
    await flush();

    expect(setAiProviderMock).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Skipped');
  });

  it('pushes project-add when the user opts to register a project', async () => {
    confirmMock.mockResolvedValueOnce(true); // intro
    confirmMock.mockResolvedValueOnce(true); // add project
    selectMock.mockResolvedValueOnce('skip');

    render(withRouter(<OnboardingView />));
    await flush();
    await flush();

    expect(routerMocks.push).toHaveBeenCalledWith({ id: 'project-add' });
  });

  it('pops back to home when the user cancels the intro prompt', async () => {
    const { PromptCancelledError } = await import('@src/business/ports/prompt.ts');
    confirmMock.mockRejectedValueOnce(new PromptCancelledError());

    render(withRouter(<OnboardingView />));
    await flush();
    await flush();

    expect(routerMocks.pop).toHaveBeenCalled();
    expect(setAiProviderMock).not.toHaveBeenCalled();
  });
});
