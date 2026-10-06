/** The descriptor carries the plan tree and the shared-mutable in-flight map for every flow. */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';

interface Ctx {
  readonly _?: never;
}

const gated = (name: string, gate: Promise<void>): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: { execute: async () => (await gate, Result.ok(undefined)) },
    input: () => undefined,
    output: (ctx) => ctx,
    label: name.toUpperCase(),
  });

describe('session-manager plan tree and live state', () => {
  it('builds planTree from runner.element for any flow', () => {
    const sessions = createSessionManager();
    const flow = sequential<Ctx>('refine', [gated('one', Promise.resolve())]);
    const { descriptor } = sessions.register({
      runner: createRunner({ id: 'r-1', element: flow, initialCtx: {} }),
      flowId: 'refine',
      title: 'Refine',
    });
    expect(descriptor.planTree?.name).toBe('refine');
    expect(descriptor.planTree?.children.map((c) => c.name)).toEqual(['one']);
    expect(descriptor.live).toEqual({ inFlight: new Map(), version: 0 });
  });

  it('sets inFlight on step-started, clears it on step and at terminal, bumping version each time', async () => {
    const sessions = createSessionManager();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const flow = sequential<Ctx>('flow', [gated('slow', gate)]);
    const runner = createRunner({ id: 'r-2', element: flow, initialCtx: {} });
    const { descriptor } = sessions.register({ runner, flowId: 'demo', title: 'Demo' });
    const live = descriptor.live!;

    const done = runner.start();
    await new Promise((res) => setTimeout(res, 0));
    expect([...live.inFlight.keys()]).toEqual(['slow']);
    const during = live.version;
    expect(during).toBeGreaterThan(0);

    release();
    await done;
    expect(live.inFlight.size).toBe(0);
    expect(live.version).toBeGreaterThan(during);
    // The descriptor keeps its identity references through the terminal rebuild.
    expect(sessions.get('r-2')?.descriptor.live).toBe(live);
    expect(sessions.get('r-2')?.descriptor.planTree).toBe(descriptor.planTree);
  });

  it('clears leftover in-flight entries when the run is aborted', async () => {
    const sessions = createSessionManager();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const runner = createRunner({
      id: 'r-3',
      element: sequential<Ctx>('flow', [gated('stuck', gate)]),
      initialCtx: {},
    });
    const { descriptor } = sessions.register({ runner, flowId: 'demo', title: 'Demo' });
    const done = runner.start();
    await new Promise((res) => setTimeout(res, 0));
    expect(descriptor.live?.inFlight.size).toBe(1);
    runner.abort();
    release();
    await done;
    expect(sessions.get('r-3')?.descriptor.live?.inFlight.size).toBe(0);
  });
});
