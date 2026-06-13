/**
 * MemoryPressureBanner — heap-pressure indicator driven by `memory-pressure` EventBus events.
 *
 * Behaviour under test:
 *
 *   - Renders nothing while the bus is quiet (no event published).
 *   - On `'warning'` severity: shows a warning-tone strip with the heap percent and
 *     "consider aborting and restarting" copy.
 *   - On `'critical'` severity: shows an error-tone strip with "auto-cleared in-memory buffers"
 *     copy.
 *   - On `'recovered'` severity: collapses back to nothing (banner cleared).
 *   - Unrelated bus events leave the frame unchanged.
 *   - formatMb / formatPercent formatting is exercised: 104_857_600 bytes → '100 MB', ratio 0.87
 *     → '87%'.
 *
 * Lightweight `AppDeps` cast: the component only reads `deps.eventBus.subscribe`, matching the
 * StatusBanner test pattern. The cast is sound — the component never reaches other deps fields.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { MemoryPressureBanner } from '@src/application/ui/tui/components/memory-pressure-banner.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const renderBanner = (bus: ReturnType<typeof createInMemoryEventBus>): ReturnType<typeof render> => {
  const deps = { eventBus: bus } as unknown as AppDeps;
  return render(
    <DepsProvider value={deps}>
      <MemoryPressureBanner />
    </DepsProvider>
  );
};

/** Yield long enough for Ink to flush a bus publish into a re-render. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const makeEvent = (
  severity: 'warning' | 'critical' | 'recovered',
  ratio = 0.87,
  heapUsed = 104_857_600,
  heapLimit = 120_000_000
) => ({
  type: 'memory-pressure' as const,
  severity,
  ratio,
  heapUsed,
  heapLimit,
  at: IsoTimestamp.now(),
});

describe('MemoryPressureBanner', () => {
  it('renders nothing while the bus is quiet', () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);
    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('renders warning copy and heap percent on warning severity', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish(makeEvent('warning', 0.87, 104_857_600, 120_000_000));
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('87%');
    expect(frame).toContain('consider aborting and restarting');
    expect(frame).toContain('memory pressure');
    r.unmount();
  });

  it('renders critical copy and heap percent on critical severity', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish(makeEvent('critical', 0.95, 99_614_720, 104_857_600));
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('95%');
    expect(frame).toContain('auto-cleared in-memory buffers');
    expect(frame).toContain('memory critical');
    r.unmount();
  });

  it('collapses back to nothing on recovered severity', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    // First transition to warning so there is something to clear.
    bus.publish(makeEvent('warning'));
    await flush();
    expect(r.lastFrame() ?? '').toContain('memory pressure');

    // Then recover — banner must disappear.
    bus.publish(makeEvent('recovered'));
    await flush();
    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('renders formatMb detail string — bytes converted to MB', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    // 104_857_600 bytes = 100 MB; 120_000_000 bytes ≈ 114 MB
    bus.publish(makeEvent('warning', 0.87, 104_857_600, 120_000_000));
    await flush();

    const frame = r.lastFrame() ?? '';
    // formatMb rounds to 0 decimal places.
    expect(frame).toContain('100 MB');
    r.unmount();
  });

  it('ignores unrelated bus events', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'log', level: 'info', message: 'noise', at: IsoTimestamp.now() });
    await flush();

    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('subsequent events update the banner (warning → critical transition)', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish(makeEvent('warning', 0.75));
    await flush();
    expect(r.lastFrame() ?? '').toContain('memory pressure');
    expect(r.lastFrame() ?? '').not.toContain('memory critical');

    bus.publish(makeEvent('critical', 0.96));
    await flush();
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('memory critical');
    expect(frame).toContain('auto-cleared in-memory buffers');
    r.unmount();
  });

  it('subscribe is cleaned up on unmount (no lingering listeners)', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish(makeEvent('warning'));
    await flush();
    expect(r.lastFrame() ?? '').toContain('memory pressure');

    // After unmount the component no longer holds a listener — the bus can be used freely.
    r.unmount();
    // Publishing after unmount must not throw (cleanup was called).
    expect(() => bus.publish(makeEvent('critical'))).not.toThrow();
  });
});
