/**
 * Behavioural proof that `useSinkStream` coalesces. REPO CONVENTION: no `vi.useFakeTimers()` in
 * rendered TUI tests — Ink's reconciler + the coalescer's real interval must run on the real
 * event loop. We pass a short `flushMs` via the test-only escape hatch and drain past it.
 *
 * 50 synchronous emits must collapse into ~1–2 React commits (not 50), and the rendered output
 * must show the trailing window. A second test proves mount-replay paints seeded history in a
 * single frame.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';

const drain = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const Probe = ({
  bus,
  onRender,
  flushMs,
}: {
  readonly bus: ReturnType<typeof createBusSink<number>>;
  readonly onRender: () => void;
  readonly flushMs: number;
}): React.JSX.Element => {
  const items = useSinkStream<number>(bus, { limit: 5, flushMs });
  onRender();
  return <Text>{items.join(',')}</Text>;
};

describe('useSinkStream coalescing', () => {
  it('collapses 50 synchronous emits into a small number of commits and shows the trailing window', async () => {
    const bus = createBusSink<number>({ maxEntries: 1000 });
    let renders = 0;
    const r = render(<Probe bus={bus} onRender={() => (renders += 1)} flushMs={20} />);

    // Let the mount effect attach the subscription before flooding.
    await drain(5);
    const rendersBeforeFlood = renders;

    for (let i = 0; i < 50; i++) bus.emit(i);

    // Drain well past one flush window so the single coalesced commit lands.
    await drain(60);

    const commitsFromFlood = renders - rendersBeforeFlood;
    expect(commitsFromFlood).toBeGreaterThanOrEqual(1);
    expect(commitsFromFlood).toBeLessThanOrEqual(2);
    // Trailing window of the last 5 values.
    expect(r.lastFrame()).toBe('45,46,47,48,49');
    r.unmount();
  });

  it('seeds mount-replay from the bus buffer and paints it in one frame', async () => {
    const bus = createBusSink<number>({ maxEntries: 1000 });
    for (let i = 0; i < 10; i++) bus.emit(i);

    const r = render(<Probe bus={bus} onRender={() => undefined} flushMs={20} />);
    await drain(5);

    // replay default true → trailing 5 of the pre-existing buffer.
    expect(r.lastFrame()).toBe('5,6,7,8,9');
    r.unmount();
  });
});
