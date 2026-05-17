import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { bridgeRunnerToEventBus } from '@src/application/observability/chain-runner-bridge.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const FROZEN = isoTimestamp('2026-05-10T10:00:00.000Z');
const fixedClock = (): typeof FROZEN => FROZEN;

interface Ctx {
  readonly seen?: number;
}

const okLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: { execute: async () => Result.ok(undefined) },
    input: () => undefined,
    output: (ctx) => ctx,
  });

const failLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, void, void>(name, {
    useCase: {
      execute: async () =>
        Result.error(new ValidationError({ field: name, value: undefined, message: `${name} blew up` })),
    },
    input: () => undefined,
    output: (ctx) => ctx,
  });

const collectEvents = (): { events: AppEvent[]; subscribe: (e: AppEvent) => void } => {
  const events: AppEvent[] = [];
  return { events, subscribe: (e) => events.push(e) };
};

describe('bridgeRunnerToEventBus', () => {
  it('publishes chain-started, chain-step-completed, chain-completed on success', async () => {
    const bus = createInMemoryEventBus();
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one'), okLeaf('two')]);
    const runner = createRunner({ id: 'r-1', element: flow, initialCtx: {} });
    bridgeRunnerToEventBus(runner, bus, { flowId: 'demo-flow', clock: fixedClock });

    await runner.start();

    const types = sink.events.map((e) => e.type);
    expect(types).toEqual(['chain-started', 'chain-step-completed', 'chain-step-completed', 'chain-completed']);

    const started = sink.events[0];
    if (started?.type !== 'chain-started') throw new Error('expected chain-started');
    expect(started.chainId).toBe('r-1');
    expect(started.flowId).toBe('demo-flow');

    const completedSteps = sink.events.filter((e) => e.type === 'chain-step-completed');
    expect(completedSteps.map((e) => (e.type === 'chain-step-completed' ? e.elementName : ''))).toEqual(['one', 'two']);
  });

  it('publishes chain-step-failed and chain-failed when a leaf fails', async () => {
    const bus = createInMemoryEventBus();
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one'), failLeaf('two')]);
    const runner = createRunner({ id: 'r-2', element: flow, initialCtx: {} });
    bridgeRunnerToEventBus(runner, bus, { flowId: 'demo-flow', clock: fixedClock });

    await runner.start();

    const types = sink.events.map((e) => e.type);
    expect(types).toEqual(['chain-started', 'chain-step-completed', 'chain-step-failed', 'chain-failed']);

    const failed = sink.events.find((e) => e.type === 'chain-step-failed');
    if (failed?.type !== 'chain-step-failed') throw new Error('expected chain-step-failed');
    expect(failed.elementName).toBe('two');
    expect(failed.error).toBeInstanceOf(ValidationError);
  });

  it('publishes chain-aborted when the runner is aborted before start', async () => {
    const bus = createInMemoryEventBus();
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-3', element: flow, initialCtx: {} });
    bridgeRunnerToEventBus(runner, bus, { flowId: 'demo-flow', clock: fixedClock });

    runner.abort('user-pressed-q');
    await runner.start();

    const types = sink.events.map((e) => e.type);
    expect(types).toEqual(['chain-aborted']);
  });

  it('auto-detaches from the runner on terminal so subsequent step replays do not fire', async () => {
    // The runner replays its trace + terminal event to any late subscriber. If the bridge did
    // NOT detach itself on terminal, a fresh subscriber added later would cause our handler to
    // re-publish stale chain events into the bus. This test simulates the late-attach by
    // letting a run complete, then forcing another subscriber to trigger sync replay — the
    // bridge's own handler must NOT fire again.
    const bus = createInMemoryEventBus();
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-detach', element: flow, initialCtx: {} });
    bridgeRunnerToEventBus(runner, bus, { flowId: 'demo-flow', clock: fixedClock });

    await runner.start();
    const eventCountAfterRun = sink.events.length;

    // Late subscriber attaches AFTER terminal → triggers replayTo, which re-fires the bridge's
    // listener IF it's still attached. We assert it isn't.
    let lateReplayCalls = 0;
    runner.subscribe(() => {
      lateReplayCalls++;
    });

    expect(lateReplayCalls).toBeGreaterThan(0); // sanity: late subscriber DID get replay
    expect(sink.events.length).toBe(eventCountAfterRun); // but bus saw no new bridge events
  });

  it('detaches even when subscribe fires the terminal listener synchronously', async () => {
    // Already-terminal runner: subscribing causes the listener to fire immediately via
    // replayTo. The bridge must finalise its detach after subscribe returns so the listener
    // doesn't linger.
    const bus = createInMemoryEventBus();
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);

    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-sync', element: flow, initialCtx: {} });
    await runner.start(); // runner is now terminal BEFORE bridge attaches

    bridgeRunnerToEventBus(runner, bus, { flowId: 'demo-flow', clock: fixedClock });
    const eventCountAfterBridge = sink.events.length;
    expect(eventCountAfterBridge).toBeGreaterThan(0); // bridge republished the replay

    // Late subscriber triggers another replayTo. Bridge must already be detached.
    let lateReplayCalls = 0;
    runner.subscribe(() => {
      lateReplayCalls++;
    });
    expect(lateReplayCalls).toBeGreaterThan(0);
    expect(sink.events.length).toBe(eventCountAfterBridge);
  });

  it('returns an idempotent detach function — calling it twice is safe and does not unsubscribe an unrelated listener', async () => {
    // Defensive: the launcher (or any caller) gets the detach handle back from the bridge.
    // Double-calling must be a no-op. Without the nullable-handle guard, a stale ref could
    // attempt to unsubscribe a future listener with the same identity.
    const bus = createInMemoryEventBus();
    const flow: Element<Ctx> = sequential<Ctx>('flow', [okLeaf('one')]);
    const runner = createRunner({ id: 'r-idem', element: flow, initialCtx: {} });
    const detach = bridgeRunnerToEventBus(runner, bus, { flowId: 'demo', clock: fixedClock });

    expect(() => {
      detach();
      detach();
      detach();
    }).not.toThrow();

    // After manual detach, completing the run must NOT push any events into the bus.
    const sink = collectEvents();
    bus.subscribe(sink.subscribe);
    await runner.start();
    expect(sink.events).toHaveLength(0);
  });
});
