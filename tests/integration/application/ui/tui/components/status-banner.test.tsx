/**
 * StatusBanner — tiered banner stack driven by `banner-show` / `banner-clear` EventBus events.
 *
 * Behaviour under test:
 *
 *   - Renders nothing while the bus is quiet.
 *   - Each tier (info / warn / error) renders with its own glyph and colour treatment so the
 *     operator can categorise at a glance.
 *   - Multiple banners stack ordered most-urgent-first (error → warn → info).
 *   - More than `MAX_VISIBLE` (3) banners collapse the surplus into a `+ N more` row.
 *   - A `banner-clear` keyed by the same id removes a previously-shown banner.
 *   - `d` keystroke dismisses the topmost (most-urgent) banner; subsequent ones move up.
 *
 * Lightweight `AppDeps` cast: the component only reads `deps.eventBus.subscribe`, faking the
 * rest would add noise. Same shape the sibling `ChainLogDegradedBanner` test uses.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { StatusBanner } from '@src/application/ui/tui/components/status-banner.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const renderBanner = (bus: ReturnType<typeof createInMemoryEventBus>): ReturnType<typeof render> => {
  const deps = { eventBus: bus } as unknown as AppDeps;
  return render(
    <DepsProvider value={deps}>
      <StatusBanner />
    </DepsProvider>
  );
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('StatusBanner', () => {
  it('renders nothing while the bus is quiet', () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);
    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('renders the info tier with its glyph and dismiss hint', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'banner-show',
      id: 'info-1',
      tier: 'info',
      message: 'Rate limit — waiting 30s',
      at: IsoTimestamp.now(),
    });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Rate limit — waiting 30s');
    expect(frame).toContain('i ');
    expect(frame).toContain('press d to dismiss');
    r.unmount();
  });

  it('renders the warn tier with the warning glyph', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'banner-show',
      id: 'warn-1',
      tier: 'warn',
      message: 'Watchdog killed stuck process (90s idle)',
      at: IsoTimestamp.now(),
    });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Watchdog killed stuck process (90s idle)');
    expect(frame).toContain('⚠');
    r.unmount();
  });

  it('renders the error tier with the cross glyph', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'banner-show',
      id: 'err-1',
      tier: 'error',
      message: 'Setup script failed for /tmp/repo: pnpm install',
      at: IsoTimestamp.now(),
    });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Setup script failed for /tmp/repo: pnpm install');
    expect(frame).toContain('✗');
    r.unmount();
  });

  it('stacks banners with error → warn → info order', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    // Publish out of order to confirm the sort, not the publish sequence.
    bus.publish({ type: 'banner-show', id: 'info-1', tier: 'info', message: 'Info one', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'err-1', tier: 'error', message: 'Error one', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'warn-1', tier: 'warn', message: 'Warn one', at: IsoTimestamp.now() });
    await flush();

    const frame = r.lastFrame() ?? '';
    const errIdx = frame.indexOf('Error one');
    const warnIdx = frame.indexOf('Warn one');
    const infoIdx = frame.indexOf('Info one');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(errIdx);
    expect(infoIdx).toBeGreaterThan(warnIdx);
    r.unmount();
  });

  it('collapses overflow past MAX_VISIBLE into a +N more row', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'banner-show', id: 'b1', tier: 'warn', message: 'first', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'b2', tier: 'warn', message: 'second', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'b3', tier: 'warn', message: 'third', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'b4', tier: 'warn', message: 'fourth', at: IsoTimestamp.now() });
    await flush();

    const frame = r.lastFrame() ?? '';
    // 3 visible, the 4th is hidden behind the collapse marker.
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).toContain('third');
    expect(frame).not.toContain('fourth');
    expect(frame).toContain('+1 more');
    r.unmount();
  });

  it('banner-clear removes the matching id', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'banner-show', id: 'b1', tier: 'warn', message: 'hello', at: IsoTimestamp.now() });
    await flush();
    expect(r.lastFrame() ?? '').toContain('hello');

    bus.publish({ type: 'banner-clear', id: 'b1', at: IsoTimestamp.now() });
    await flush();

    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('re-publishing the same id replaces rather than stacking', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'banner-show', id: 'b1', tier: 'warn', message: 'first text', at: IsoTimestamp.now() });
    await flush();
    bus.publish({ type: 'banner-show', id: 'b1', tier: 'warn', message: 'updated text', at: IsoTimestamp.now() });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('updated text');
    expect(frame).not.toContain('first text');
    // Not "+1 more" — same id replaced in place.
    expect(frame).not.toContain('more');
    r.unmount();
  });

  it('d dismisses the topmost (most-urgent) banner; lower-tier banners move up', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'banner-show', id: 'info-1', tier: 'info', message: 'info line', at: IsoTimestamp.now() });
    bus.publish({ type: 'banner-show', id: 'err-1', tier: 'error', message: 'error line', at: IsoTimestamp.now() });
    await flush();

    expect(r.lastFrame() ?? '').toContain('error line');
    expect(r.lastFrame() ?? '').toContain('info line');

    r.stdin.write('d');
    // useInput dispatches asynchronously; give Ink a tick to flush the keystroke through
    // its raw-input handler and re-render. flush() alone races the keystroke.
    await tick(80);

    const frame = r.lastFrame() ?? '';
    // Error (topmost) dismissed; info remains.
    expect(frame).not.toContain('error line');
    expect(frame).toContain('info line');
    r.unmount();
  });

  it('ignores unrelated events on the bus', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({ type: 'log', level: 'info', message: 'noise', at: IsoTimestamp.now() });
    await flush();

    expect(r.lastFrame() ?? '').toBe('');
    r.unmount();
  });

  it('renders the optional cause beside the message', async () => {
    const bus = createInMemoryEventBus();
    const r = renderBanner(bus);

    bus.publish({
      type: 'banner-show',
      id: 'b1',
      tier: 'info',
      message: 'Rate limit — waiting 30s',
      cause: 'attempt 2/4',
      at: IsoTimestamp.now(),
    });
    await flush();

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Rate limit — waiting 30s');
    expect(frame).toContain('attempt 2/4');
    r.unmount();
  });
});
