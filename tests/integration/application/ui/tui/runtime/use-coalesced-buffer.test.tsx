/**
 * React-level coverage for {@link useCoalescedBuffer} — the hook seam that decouples a hot source
 * from React's commit rate. The pure buffer is unit-tested separately (coalesced-buffer.test.ts);
 * here we prove the *hook contract*:
 *
 *   1. N synchronous emits in one flush window collapse into one commit carrying the LAST state.
 *   2. The unmount cleanup releases the subscription (no leaked listener) AND cancels the pending
 *      flush — a source emit AFTER unmount must not reach `setState` (no "update on an unmounted
 *      component" path, no late commit).
 *
 * REPO CONVENTION: no `vi.useFakeTimers()` inside an ink-testing-library render — Ink's reconciler
 * and the coalescer's real interval run on the real event loop. We pass a short `flushMs` via the
 * test-only escape hatch and drain past it. A `BusSink` is the source so we can assert
 * `subscriberCount` to prove the cleanup detached.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createBusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';
import { useCoalescedBuffer } from '@src/application/ui/tui/runtime/use-coalesced-buffer.ts';

const drain = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const Probe = ({
  bus,
  onRender,
}: {
  readonly bus: ReturnType<typeof createBusSink<number>>;
  readonly onRender: () => void;
}): React.JSX.Element => {
  const items = useCoalescedBuffer<number>({
    limit: 3,
    flushMs: 20,
    subscribe: (push) => bus.subscribe(push),
    deps: [bus],
  });
  onRender();
  return <Text>{items.join(',')}</Text>;
};

describe('useCoalescedBuffer', () => {
  it('collapses a flood of emits in one window into a single commit carrying the last state', async () => {
    const bus = createBusSink<number>({ maxEntries: 1000 });
    let renders = 0;
    const r = render(<Probe bus={bus} onRender={() => (renders += 1)} />);

    // Let the mount effect attach the subscription before flooding.
    await drain(5);
    const baseline = renders;

    for (let i = 0; i < 40; i++) bus.emit(i);

    // Drain past one flush window — the 40 emits must coalesce into ~1 commit, not 40.
    await drain(50);

    const commits = renders - baseline;
    expect(commits).toBeGreaterThanOrEqual(1);
    expect(commits).toBeLessThanOrEqual(2);
    // The trailing window (limit 3) of the LAST values wins.
    expect(r.lastFrame()).toBe('37,38,39');
    r.unmount();
  });

  it('unmount detaches the subscription and cancels the pending flush — no post-unmount commit', async () => {
    const bus = createBusSink<number>({ maxEntries: 1000 });
    let renders = 0;
    const r = render(<Probe bus={bus} onRender={() => (renders += 1)} />);
    await drain(5);

    // Push a value but unmount BEFORE the flush window elapses, so a flush is pending.
    bus.emit(1);
    expect(bus.subscriberCount).toBe(1);

    r.unmount();

    // Cleanup must have detached the listener so no further emit can be routed into the buffer.
    expect(bus.subscriberCount).toBe(0);

    const rendersAtUnmount = renders;

    // A late emit AFTER unmount, plus a drain past the (now-stopped) flush interval. Neither the
    // detached subscription nor a stale interval may drive another commit / setState on the
    // unmounted component.
    bus.emit(2);
    await drain(50);
    expect(renders).toBe(rendersAtUnmount);
  });
});
