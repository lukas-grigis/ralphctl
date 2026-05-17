/**
 * Regression: pressing `n` while a TextPrompt is mounted must NOT trigger the global "new
 * flow" navigation. The session bug: a wizard claimed promptActive via useEffect but the
 * PromptHost stomped it back to false whenever its own queue was empty, leaking typed
 * characters that happened to be global hotkeys (n, s, x, !) into the router.
 *
 * Setup: a minimal harness that mounts UiStateProvider + RouterProvider + useGlobalKeys, then
 * a child that claims promptActive on mount and renders a TextPrompt. Typing "blinced" should
 * land 7 chars in the buffer and leave the router on its initial view.
 */

import React, { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { RouterProvider, useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const GlobalHarness = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  return <>{children}</>;
};

const ClaimingPrompt = ({ onSubmit }: { readonly onSubmit: (value: string) => void }): React.JSX.Element => {
  const ui = useUiState();
  useEffect(() => ui.claimPrompt(), [ui.claimPrompt]);
  return <TextPrompt message="type" onSubmit={onSubmit} onCancel={() => undefined} />;
};

const Harness = ({ onSubmit }: { readonly onSubmit: (value: string) => void }): React.JSX.Element => (
  <UiStateProvider>
    <RouterProvider initial={{ id: 'home' }}>
      {(): React.JSX.Element => (
        <GlobalHarness>
          <RouterAwareChild onSubmit={onSubmit} />
        </GlobalHarness>
      )}
    </RouterProvider>
  </UiStateProvider>
);

const RouterAwareChild = ({ onSubmit }: { readonly onSubmit: (value: string) => void }): React.JSX.Element => {
  const router = useRouter();
  return (
    <>
      <ClaimingPrompt
        onSubmit={(value) => {
          onSubmit(value);
        }}
      />
      <ViewProbe currentId={router.current.id} />
    </>
  );
};

const probeIds: string[] = [];
const ViewProbe = ({ currentId }: { readonly currentId: string }): React.JSX.Element => {
  useEffect(() => {
    probeIds.push(currentId);
  });
  return <></>;
};

describe('promptActive claim suppresses global hotkeys', () => {
  it('typing "blinced" does not trigger the global "n" → flows navigation', async () => {
    probeIds.length = 0;
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<Harness onSubmit={onSubmit} />);
    await tick(50); // give the claim effect time to run
    stdin.write('blinced');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('blinced');
    // Router must have stayed on 'home' throughout. ViewProbe records every render's id;
    // if `n` had leaked to useGlobalKeys, we'd see 'flows' here.
    expect(probeIds.every((id) => id === 'home')).toBe(true);
    unmount();
  });

  it('typing matches global hotkeys for all four leak-prone letters', async () => {
    probeIds.length = 0;
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(<Harness onSubmit={onSubmit} />);
    await tick(50);
    // n=flows, s=settings, x=sessions, ! (shift+1) doesn't co-occur with text but cover the
    // letter-only ones explicitly.
    stdin.write('nsxh');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('nsxh');
    expect(probeIds.every((id) => id === 'home')).toBe(true);
    unmount();
  });
});
