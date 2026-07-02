/**
 * `useSessionTransitionReload` — verifies the shared status-diff subscription extracted from
 * `use-sprint-bundle.ts`: `reload` fires when a tracked session's status transitions (including
 * a fresh registration), but NOT on a trace-only `step` notify that leaves every descriptor's
 * status untouched. This is the mechanism behind the flows-view / home-view staleness fix — both
 * views render sprint-derived state and previously only refreshed on a manual `r`, never on flow
 * completion.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSessionTransitionReload } from '@src/application/ui/tui/runtime/use-session-transition-reload.ts';

interface Ctx {
  readonly _?: never;
}
const okLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: { execute: async () => Result.ok(undefined) },
    input: () => undefined,
    output: (ctx) => ctx,
  });

const Probe = ({ onReload }: { readonly onReload: () => void }): React.JSX.Element => {
  useSessionTransitionReload(onReload);
  return <Text>probe</Text>;
};

describe('useSessionTransitionReload', () => {
  it('fires reload on a status transition but not on a trace-only step notify', async () => {
    const sessions = createSessionManager();
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one'), okLeaf('two')]);
    const runner = createRunner({ id: 'r-1', element: flow, initialCtx: {} });
    // Register before mounting the Probe so the manager's registration-time notify (fired
    // synchronously inside `register()`) isn't observed by the hook's subscription — isolates
    // the assertion to transitions that occur once the hook is subscribed.
    sessions.register({ runner, flowId: 'demo', title: 'Demo' });

    let reloadCount = 0;
    const r = render(
      <SessionsProvider value={sessions}>
        <Probe onReload={() => (reloadCount += 1)} />
      </SessionsProvider>
    );

    expect(reloadCount).toBe(0);

    // Drives: 'started' (idle → running, status change), 'step' × 2 (trace-only, no status
    // change), 'completed' (running → completed, status change).
    await runner.start();

    // Two status transitions (idle→running, running→completed) — the two trace-only step
    // notifies in between must not have bumped the count.
    expect(reloadCount).toBe(2);

    r.unmount();
  });

  it('fires reload when a new session is registered after mount', () => {
    const sessions = createSessionManager();
    let reloadCount = 0;
    const r = render(
      <SessionsProvider value={sessions}>
        <Probe onReload={() => (reloadCount += 1)} />
      </SessionsProvider>
    );
    expect(reloadCount).toBe(0);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-2', element: flow, initialCtx: {} });
    sessions.register({ runner, flowId: 'demo', title: 'Demo' });

    expect(reloadCount).toBe(1);
    r.unmount();
  });
});
