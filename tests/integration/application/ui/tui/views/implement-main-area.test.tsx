/**
 * ImplementMainArea — Esc-collapse-before-pop wiring (wide-layout ≥140 col Implement view).
 *
 * Mounts `useGlobalKeys` alongside `ImplementMainArea` inside the shared `renderView` harness
 * (which already provides `UiStateProvider` + `RouterProvider`) so the test exercises the real
 * "esc → collapse card" vs "esc → router.pop()" race, not a synthetic stand-in. A second route
 * is pushed on mount so a pop is observable (`renderView`'s single `initial` entry can't pop).
 *
 * `ImplementMainArea` claims `esc` (via `useUiState().claimEscape()`) whenever the focused card
 * is expanded — `TasksPanel`'s own `useInput` collapses the card on the same keystroke — and
 * releases the claim the instant the card collapses or the component unmounts.
 */

import React from 'react';
import { Text, useInput } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { ImplementMainArea } from '@src/application/ui/tui/views/execute-view-internals/implement-main-area.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const LIVE_SIGNAL_TEXT = 'task-1 live change';

/** One running task, auto-expanded on mount (the active-task seed in `useTaskCardState`). */
const BUCKETED: BucketedExecution = {
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [{ type: 'change', text: LIVE_SIGNAL_TEXT, timestamp: ts(1) }],
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
};

const DESCRIPTOR: SessionDescriptor = {
  id: 'sess-esc-test',
  flowId: 'implement',
  title: 'Esc Collapse Test Sprint',
  status: 'running',
  startedAt: Date.now(),
  trace: [],
};

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const stubDeps = (): AppDeps => ({ eventBus: noopEventBus }) as unknown as AppDeps;

/**
 * Mounts the real global key handler + a route-depth probe + `ImplementMainArea`. Pushes a
 * second route on mount so `router.pop()` is observable, and exposes a `u` hotkey to unmount
 * `ImplementMainArea` on demand (scenario c — claim-release-on-unmount).
 */
const Harness = (): React.JSX.Element => {
  useGlobalKeys();
  const router = useRouter();
  const pushedRef = React.useRef(false);
  React.useEffect(() => {
    if (pushedRef.current) return;
    pushedRef.current = true;
    router.push({ id: 'sessions' });
  }, [router]);

  const [mounted, setMounted] = React.useState(true);
  useInput((input) => {
    if (input === 'u') setMounted(false);
  });

  return (
    <>
      <Text>
        ROUTE:{router.current.id}:{String(router.stack.length)}
      </Text>
      {mounted && (
        <ImplementMainArea
          bucketed={BUCKETED}
          descriptor={DESCRIPTOR}
          isRunning={true}
          maxSignalsPerTask={8}
          maxTasks={5}
          inputActive={true}
          now={Date.now()}
          taskState={undefined}
        />
      )}
    </>
  );
};

const mount = (): ReturnType<typeof renderView> =>
  renderView(<Harness />, { deps: stubDeps(), initial: { id: 'execute' } });

describe('ImplementMainArea — Esc collapse-before-pop', () => {
  it('Esc collapses the expanded focused card and does NOT pop the route', async () => {
    const { result } = mount();
    await waitForViewReady(result, (f) => f.includes(LIVE_SIGNAL_TEXT));
    // Confirm the second route + the live claim's precondition (card expanded) both settled.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('ROUTE:sessions:2'));

    result.stdin.write(ESC);
    await tick(60);

    const frame = result.lastFrame() ?? '';
    // Card collapsed — its signal stream is no longer rendered.
    expect(frame).not.toContain(LIVE_SIGNAL_TEXT);
    // The route did NOT pop — the claim kept the global handler's router.pop() from firing.
    expect(frame).toContain('ROUTE:sessions:2');

    result.unmount();
  });

  it('Esc with no expanded card pops the route as before', async () => {
    const { result } = mount();
    await waitForViewReady(result, (f) => f.includes(LIVE_SIGNAL_TEXT));
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('ROUTE:sessions:2'));

    // First Esc collapses the auto-expanded card (releasing the claim).
    result.stdin.write(ESC);
    await tick(60);
    expect(result.lastFrame() ?? '').not.toContain(LIVE_SIGNAL_TEXT);
    expect(result.lastFrame() ?? '').toContain('ROUTE:sessions:2');

    // Second Esc — no card expanded, no claim held — the global handler pops the route.
    result.stdin.write(ESC);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('ROUTE:execute:1'));
    expect(result.lastFrame() ?? '').toContain('ROUTE:execute:1');

    result.unmount();
  });

  it('unmounting while expanded releases the claim (no stale claim blocking Esc elsewhere)', async () => {
    const { result } = mount();
    await waitForViewReady(result, (f) => f.includes(LIVE_SIGNAL_TEXT));
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('ROUTE:sessions:2'));

    // Unmount ImplementMainArea while its focused card is still expanded — the claim is live.
    result.stdin.write('u');
    await tick(30);
    expect(result.lastFrame() ?? '').not.toContain(LIVE_SIGNAL_TEXT);

    // A leaked claim would swallow this Esc forever; the unmount cleanup must have released it.
    result.stdin.write(ESC);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('ROUTE:execute:1'));
    expect(result.lastFrame() ?? '').toContain('ROUTE:execute:1');

    result.unmount();
  });
});
