/**
 * `useViewKeys` — claims + special keys. The hint/handler single-source behaviour is covered
 * with the hint registry; this file pins the keyboard-ownership additions: enabled printable
 * keys are claimed, disabled ones are not, `↵` / `esc` bind, and an open app overlay mutes the
 * dispatcher.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { ClaimedKeysProvider, useClaimedKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const Probe = ({
  bindings,
  seen,
  openHelp,
  claimPrompt,
}: {
  readonly bindings: readonly ViewKeyBinding[];
  readonly seen: { isClaimed?: (key: string) => boolean; modalOpen?: boolean };
  readonly openHelp?: boolean;
  readonly claimPrompt?: boolean;
}): React.JSX.Element => {
  const { isClaimed } = useClaimedKeys();
  const ui = useUiState();
  useViewKeys(bindings);
  React.useEffect(() => {
    if (openHelp) ui.toggleHelp();
  }, [openHelp, ui.toggleHelp]);
  React.useEffect(() => (claimPrompt ? ui.claimPrompt() : undefined), [claimPrompt, ui.claimPrompt]);
  seen.isClaimed = isClaimed;
  seen.modalOpen = ui.modalOpen;
  return <Text>probe</Text>;
};

const mount = (node: React.ReactNode): ReturnType<typeof render> =>
  render(
    <UiStateProvider>
      <HintsProvider>
        <ClaimedKeysProvider>{node}</ClaimedKeysProvider>
      </HintsProvider>
    </UiStateProvider>
  );

describe('useViewKeys — keyboard ownership', () => {
  it('claims enabled printable keys with a handler, and only those', async () => {
    const seen = {} as { isClaimed?: (key: string) => boolean };
    const r = mount(
      <Probe
        seen={seen}
        bindings={[
          { keys: ['a'], hint: 'a', run: vi.fn() },
          { keys: ['b'], hint: 'b', enabled: false, run: vi.fn() },
          { keys: ['x'], hint: 'doc only' },
        ]}
      />
    );
    await tick();
    expect(['a', 'b', 'x'].map((k) => seen.isClaimed?.(k))).toEqual([true, false, false]);
    r.unmount();
  });

  it('binds ↵ and esc to their keys', async () => {
    const onEnter = vi.fn();
    const onEsc = vi.fn();
    const seen = {} as { isClaimed?: (key: string) => boolean };
    const r = mount(
      <Probe
        seen={seen}
        bindings={[
          { keys: ['↵'], hint: 'go', run: onEnter },
          { keys: ['esc'], hint: 'back', run: onEsc },
        ]}
      />
    );
    await tick();
    r.stdin.write('\r');
    await tick();
    r.stdin.write(String.fromCharCode(27));
    await tick(60);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEsc).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it('mutes itself while an app overlay is open', async () => {
    const run = vi.fn();
    const seen = {} as { isClaimed?: (key: string) => boolean; modalOpen?: boolean };
    const r = mount(<Probe seen={seen} openHelp bindings={[{ keys: ['a'], hint: 'a', run }]} />);
    // Wait for the mute to commit, not a fixed delay — the full suite can starve a 60ms tick.
    await vi.waitFor(() => expect(seen.modalOpen).toBe(true));
    await tick();
    r.stdin.write('a');
    await tick();
    expect(run).not.toHaveBeenCalled();
    r.unmount();
  });

  it('mutes itself while a prompt holds the keyboard', async () => {
    const run = vi.fn();
    const seen = {} as { isClaimed?: (key: string) => boolean; modalOpen?: boolean };
    const r = mount(<Probe seen={seen} claimPrompt bindings={[{ keys: ['↵'], hint: 'go', run }]} />);
    // Wait for the mute to commit, not a fixed delay — the full suite can starve a 60ms tick.
    await vi.waitFor(() => expect(seen.modalOpen).toBe(true));
    await tick();
    r.stdin.write('\r');
    await tick();
    expect(run).not.toHaveBeenCalled();
    r.unmount();
  });

  it('never fires a letter binding on its ctrl or alt chord', async () => {
    const onC = vi.fn();
    const seen = {} as { isClaimed?: (key: string) => boolean };
    const r = mount(<Probe seen={seen} bindings={[{ keys: ['c'], hint: 'cancel', run: onC }]} />);
    await tick(60);
    r.stdin.write('\u0003');
    r.stdin.write('\u001bc');
    await tick();
    expect(onC).not.toHaveBeenCalled();
    r.stdin.write('c');
    await tick();
    expect(onC).toHaveBeenCalledOnce();
    r.unmount();
  });

  it('fires a binding that asks for the chord, and only on it', async () => {
    const onCtrlO = vi.fn();
    const seen = {} as { isClaimed?: (key: string) => boolean };
    const r = mount(<Probe seen={seen} bindings={[{ keys: ['o'], hint: 'open', chord: 'ctrl', run: onCtrlO }]} />);
    await tick(60);
    r.stdin.write('o');
    await tick();
    expect(onCtrlO).not.toHaveBeenCalled();
    r.stdin.write('\u000f');
    await tick();
    expect(onCtrlO).toHaveBeenCalledOnce();
    expect(seen.isClaimed?.('o')).toBe(false);
    r.unmount();
  });
});
