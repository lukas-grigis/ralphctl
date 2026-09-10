/**
 * The settled-run hint strip must advertise the `u` unblock chord — otherwise a live, working
 * affordance is discoverable only by opening the `?` help overlay (see `keyboard-map.ts`'s
 * `tasksPanelKeys.unblock`, which never otherwise reaches `useViewHints`). Gated on
 * `hasBlockedTask` (mirroring `v evaluation`'s `hasEvaluation` gate) and shown ONLY in the settled
 * set — the Tasks panel forces the `u` chord inert while a run is live (see
 * `tasks-panel-host.tsx`'s TOCTOU note), so hinting it during a run would advertise a key whose
 * handler rejects every press.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { HintsProvider, useActiveHints, type ViewHint } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useExecuteInput } from '@src/application/ui/tui/views/execute-view-internals/use-execute-input.ts';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';

const stubRouter = (): RouterApi =>
  ({
    stack: [],
    current: { id: 'home' },
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  }) as unknown as RouterApi;

const flush = async (): Promise<void> => {
  await new Promise((res) => setTimeout(res, 5));
};

const Publisher = ({
  isRunning,
  hasBlockedTask,
}: {
  readonly isRunning: boolean;
  readonly hasBlockedTask?: boolean;
}): React.JSX.Element => {
  useExecuteInput({
    isRunning,
    cancelScopeOpen: false,
    setCancelScopeOpen: vi.fn(),
    modalOpen: false,
    router: stubRouter(),
    hasPinnedSprint: true,
    hasEvaluation: false,
    ...(hasBlockedTask !== undefined ? { hasBlockedTask } : {}),
  });
  return <Text>publisher</Text>;
};

const Reader = ({ onState }: { readonly onState: (hints: readonly ViewHint[]) => void }): React.JSX.Element => {
  const active = useActiveHints();
  onState(active);
  return <Text>reader</Text>;
};

describe('useExecuteInput — settled u unblock hint', () => {
  it('advertises `u unblock` in the settled hint set when a task is blocked', async () => {
    let last: readonly ViewHint[] = [];
    const r = render(
      <HintsProvider>
        <Publisher isRunning={false} hasBlockedTask={true} />
        <Reader onState={(h) => (last = h)} />
      </HintsProvider>
    );
    await flush();

    const unblockHint = last.find((h) => h.keys === 'u');
    expect(unblockHint).toBeDefined();
    expect(unblockHint?.label).toBe('unblock');
    r.unmount();
  });

  it('omits `u unblock` when no task is blocked', async () => {
    let last: readonly ViewHint[] = [];
    const r = render(
      <HintsProvider>
        <Publisher isRunning={false} hasBlockedTask={false} />
        <Reader onState={(h) => (last = h)} />
      </HintsProvider>
    );
    await flush();

    expect(last.find((h) => h.keys === 'u')).toBeUndefined();
    r.unmount();
  });

  it('never advertises `u unblock` while the run is live, even with a blocked task', async () => {
    let last: readonly ViewHint[] = [];
    const r = render(
      <HintsProvider>
        <Publisher isRunning={true} hasBlockedTask={true} />
        <Reader onState={(h) => (last = h)} />
      </HintsProvider>
    );
    await flush();

    expect(last.find((h) => h.keys === 'u')).toBeUndefined();
    r.unmount();
  });

  it('degrades to no hint when the caller omits hasBlockedTask (backward compatible)', async () => {
    let last: readonly ViewHint[] = [];
    const r = render(
      <HintsProvider>
        <Publisher isRunning={false} />
        <Reader onState={(h) => (last = h)} />
      </HintsProvider>
    );
    await flush();

    expect(last.find((h) => h.keys === 'u')).toBeUndefined();
    r.unmount();
  });
});
