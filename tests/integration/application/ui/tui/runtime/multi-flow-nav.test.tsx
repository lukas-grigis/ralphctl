/**
 * Multi-flow navigation chords wired in `useGlobalKeys`:
 *   - Tab / Shift+Tab cycle through the RUNNING sessions (modular wrap),
 *   - Ctrl+1..9 jump to the Nth running session (1-indexed),
 *   - both reuse the Sessions view's route (`{ id: 'execute', props: { sessionId } }`),
 *   - both are inert while a prompt is mounted (promptActive > 0) or an overlay is open,
 *   - with zero running sessions every chord is a silent no-op.
 *
 * Tab/Shift+Tab/Ctrl+digit are simulated with the exact byte sequences Ink parses into
 * `key.tab` / `key.tab + key.shift` / `key.ctrl + input='3'` (the kitty CSI-u form is the only
 * way Ink ever surfaces a Ctrl+digit with `key.ctrl === true`).
 */

import React, { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner, RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { SessionManager, SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { RouterProvider, useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

/** Special-key byte sequences exactly as Ink's parseKeypress expects them. */
const TAB = '\t';
const SHIFT_TAB = `${String.fromCharCode(27)}[Z`;
const ctrlDigit = (n: number): string => `${String.fromCharCode(27)}[${48 + n};5u`;

/** Minimal AppDeps stub — the global handler only reaches for `deps.eventBus`. */
const stubDeps = (): AppDeps => ({ eventBus: createInMemoryEventBus() }) as unknown as AppDeps;

const FAKE_RUNNER = { id: 'r', subscribe: () => () => undefined } as unknown as Runner<unknown>;

const sess = (id: string, status: RunnerStatus = 'running'): SessionRecord => ({
  descriptor: { id, flowId: 'implement', title: id, status, startedAt: Date.now(), trace: [] },
  runner: FAKE_RUNNER,
});

/** Read-only fake manager: only `list()` and `subscribe()` are exercised by the handler. */
const fakeManager = (records: readonly SessionRecord[]): SessionManager =>
  ({
    list: () => records,
    get: (id: string) => records.find((r) => r.descriptor.id === id),
    subscribe: () => () => undefined,
  }) as unknown as SessionManager;

interface HarnessProps {
  readonly manager: SessionManager;
  readonly initial: ViewEntry;
  readonly onRoute: (entry: ViewEntry) => void;
  readonly claimPrompt?: boolean;
  readonly openOverlay?: boolean;
}

/** Mounts `useGlobalKeys` behind the production `disabled: ui.promptActive` gate. */
const Inner = ({
  claimPrompt,
  openOverlay,
}: {
  claimPrompt?: boolean | undefined;
  openOverlay?: boolean | undefined;
}): React.JSX.Element => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  useEffect(() => (claimPrompt ? ui.claimPrompt() : undefined), [claimPrompt, ui.claimPrompt]);
  // Open the help overlay (a representative overlay) to verify chords are inert while one is up.
  const toggleHelp = ui.toggleHelp;
  useEffect(() => {
    if (openOverlay) toggleHelp();
  }, [openOverlay, toggleHelp]);
  return <></>;
};

const RouteProbe = ({ onRoute }: { readonly onRoute: (e: ViewEntry) => void }): React.JSX.Element => {
  const router = useRouter();
  useEffect(() => {
    onRoute(router.current);
  });
  return <></>;
};

const Harness = ({ manager, initial, onRoute, claimPrompt, openOverlay }: HarnessProps): React.JSX.Element => (
  <DepsProvider value={stubDeps()}>
    <SessionsProvider value={manager}>
      <SelectionProvider>
        <UiStateProvider>
          <RouterProvider initial={initial}>
            {(): React.JSX.Element => (
              <>
                <Inner claimPrompt={claimPrompt} openOverlay={openOverlay} />
                <RouteProbe onRoute={onRoute} />
              </>
            )}
          </RouterProvider>
        </UiStateProvider>
      </SelectionProvider>
    </SessionsProvider>
  </DepsProvider>
);

/** The session id the execute route is currently focused on, or undefined when off-execute. */
const focusedSessionId = (entry: ViewEntry): string | undefined =>
  entry.id === 'execute' ? (entry.props?.sessionId as string | undefined) : undefined;

describe('multi-flow navigation chords', () => {
  it('Tab cycles to the next running session', async () => {
    const manager = fakeManager([sess('a'), sess('b'), sess('c')]);
    let current: ViewEntry = { id: 'execute', props: { sessionId: 'a' } };
    const { stdin, unmount } = render(<Harness manager={manager} initial={current} onRoute={(e) => (current = e)} />);
    await tick(50);
    stdin.write(TAB);
    await tick();
    // a → b on the execute view (replace, not push).
    expect(focusedSessionId(current)).toBe('b');
    stdin.write(TAB);
    await tick();
    expect(focusedSessionId(current)).toBe('c');
    // Wraps modularly back to the first.
    stdin.write(TAB);
    await tick();
    expect(focusedSessionId(current)).toBe('a');
    unmount();
  });

  it('Shift+Tab cycles to the previous running session (with modular wrap)', async () => {
    const manager = fakeManager([sess('a'), sess('b'), sess('c')]);
    let current: ViewEntry = { id: 'execute', props: { sessionId: 'b' } };
    const { stdin, unmount } = render(<Harness manager={manager} initial={current} onRoute={(e) => (current = e)} />);
    await tick(50);
    stdin.write(SHIFT_TAB);
    await tick();
    // b → a (previous).
    expect(focusedSessionId(current)).toBe('a');
    // Wraps modularly back to the last.
    stdin.write(SHIFT_TAB);
    await tick();
    expect(focusedSessionId(current)).toBe('c');
    unmount();
  });

  it('Ctrl+3 jumps to the 3rd running session from a non-execute view (push path)', async () => {
    const manager = fakeManager([sess('a'), sess('b'), sess('c')]);
    let current: ViewEntry = { id: 'home' };
    const { stdin, unmount } = render(<Harness manager={manager} initial={current} onRoute={(e) => (current = e)} />);
    await tick(50);
    stdin.write(ctrlDigit(3));
    await tick();
    expect(current.id).toBe('execute');
    expect(focusedSessionId(current)).toBe('c');
    unmount();
  });

  it('Tab is inert while a prompt is active', async () => {
    const manager = fakeManager([sess('a'), sess('b')]);
    let current: ViewEntry = { id: 'execute', props: { sessionId: 'a' } };
    const { stdin, unmount } = render(
      <Harness manager={manager} initial={current} onRoute={(e) => (current = e)} claimPrompt />
    );
    await tick(50);
    stdin.write(TAB);
    await tick();
    // promptActive > 0 ⇒ the whole global handler is muted; focus stays put.
    expect(focusedSessionId(current)).toBe('a');
    unmount();
  });

  it('Tab is inert while an overlay is open', async () => {
    const manager = fakeManager([sess('a'), sess('b')]);
    let current: ViewEntry = { id: 'execute', props: { sessionId: 'a' } };
    const { stdin, unmount } = render(
      <Harness manager={manager} initial={current} onRoute={(e) => (current = e)} openOverlay />
    );
    await tick(50);
    stdin.write(TAB);
    await tick();
    // Help overlay open ⇒ the overlay branch early-returns before the chord; focus stays put.
    expect(focusedSessionId(current)).toBe('a');
    unmount();
  });

  it('Tab is a no-op with zero running sessions', async () => {
    const manager = fakeManager([sess('a', 'completed'), sess('b', 'aborted')]);
    let current: ViewEntry = { id: 'home' };
    const { stdin, unmount } = render(<Harness manager={manager} initial={current} onRoute={(e) => (current = e)} />);
    await tick(50);
    stdin.write(TAB);
    await tick();
    // No running sessions ⇒ silent no-op; the router never leaves home.
    expect(current.id).toBe('home');
    unmount();
  });

  it('Tab with exactly one running session does not call the router (same-session guard)', async () => {
    // When there is only one running session, Tab cycles back to the same session. Without the
    // guard, router.replace fires with an identical entry causing a wasteful re-render.
    // The guard short-circuits when the target id equals the focused id.
    const manager = fakeManager([sess('only')]);
    const routeCalls: ViewEntry[] = [];
    let current: ViewEntry = { id: 'execute', props: { sessionId: 'only' } };
    const { stdin, unmount } = render(
      <Harness
        manager={manager}
        initial={current}
        onRoute={(e) => {
          routeCalls.push(e);
          current = e;
        }}
      />
    );
    await tick(50);
    // Drain the initial route probe call(s) that fire on mount.
    const callsBeforeTab = routeCalls.length;
    stdin.write(TAB);
    await tick();
    // The route must not have changed and no new router calls should have been made.
    expect(current.id).toBe('execute');
    expect(focusedSessionId(current)).toBe('only');
    // No additional route callbacks beyond the initial mount probe.
    expect(routeCalls.length).toBe(callsBeforeTab);
    unmount();
  });
});
