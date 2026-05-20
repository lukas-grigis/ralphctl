/**
 * ChainLogDegradedBanner — latch behavior. The banner is the only UI surface that flips
 * the operator from "trust the on-disk trace" to "do not". It must:
 *   - render NOTHING while the bus is quiet (most of the time)
 *   - flip on after the first `chain-log-degraded` event
 *   - STAY on after any subsequent events — auto-clear would hide the degraded state and
 *     defeat the whole point of the banner.
 *
 * We provide a minimal `AppDeps` cast: the component only reads `deps.eventBus.subscribe`,
 * so faking the rest of the dependency surface would add noise without adding signal.
 */

import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { ChainLogDegradedBanner } from '@src/application/ui/tui/components/chain-log-degraded-banner.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const renderBanner = (bus: ReturnType<typeof createInMemoryEventBus>): ReturnType<typeof render> => {
  const deps = { eventBus: bus } as unknown as AppDeps;
  return render(
    <DepsProvider value={deps}>
      <ChainLogDegradedBanner />
    </DepsProvider>
  );
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  // Ink-testing-library's module-level instance list is drained per render.unmount() in
  // each test, so no extra cleanup needed here.
});

describe('ChainLogDegradedBanner', () => {
  it('renders nothing while the chain log is healthy', () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);
    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('renders the warning strip after the first chain-log-degraded event', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'chain-log-degraded',
      reason: 'queue-full',
      at: IsoTimestamp.now(),
    });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('chain log degraded');
    expect(frame).toContain('postmortem trace may be incomplete');
    r.unmount();
  });

  it('stays latched — a second event does not clear or re-mount the banner', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'chain-log-degraded',
      reason: 'queue-full',
      at: IsoTimestamp.now(),
    });
    await flush();
    const after1 = r.lastFrame() ?? '';
    expect(after1).toContain('chain log degraded');

    bus.publish({
      type: 'chain-log-degraded',
      reason: 'write-failed',
      meta: { error: 'disk full' },
      at: IsoTimestamp.now(),
    });
    await flush();
    const after2 = r.lastFrame() ?? '';

    // Same banner content — the local state was already latched, the second event is a no-op.
    expect(after2).toContain('chain log degraded');
    expect(after2).toContain('postmortem trace may be incomplete');
    expect(after2).toBe(after1);
    r.unmount();
  });

  it('ignores unrelated events on the bus', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'log',
      level: 'info',
      message: 'hello',
      at: IsoTimestamp.now(),
    });
    await flush();

    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });
});
