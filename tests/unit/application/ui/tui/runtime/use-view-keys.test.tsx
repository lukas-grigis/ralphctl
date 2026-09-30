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
}: {
  readonly bindings: readonly ViewKeyBinding[];
  readonly seen: { isClaimed?: (key: string) => boolean };
  readonly openHelp?: boolean;
}): React.JSX.Element => {
  const { isClaimed } = useClaimedKeys();
  const ui = useUiState();
  useViewKeys(bindings);
  React.useEffect(() => {
    if (openHelp) ui.toggleHelp();
  }, [openHelp, ui.toggleHelp]);
  seen.isClaimed = isClaimed;
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
    const seen = {} as { isClaimed?: (key: string) => boolean };
    const r = mount(<Probe seen={seen} openHelp bindings={[{ keys: ['a'], hint: 'a', run }]} />);
    await tick(60);
    r.stdin.write('a');
    await tick();
    expect(run).not.toHaveBeenCalled();
    r.unmount();
  });
});
