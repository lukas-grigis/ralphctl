/**
 * Verify the ref-based capture inside `useEventBus` / `useEventBusBuffer`: a caller that passes
 * a fresh arrow function on every render must NOT churn the underlying bus subscription. If
 * the deps array included `handler` / `opts` directly, every parent re-render would cycle the
 * subscription and lose buffered state mid-render. The hooks capture both via a ref so the
 * subscription is established once per `bus`/`limit` for the component's lifetime.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import type { AppEvent, ChainCompletedEvent } from '@src/business/observability/events.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const Probe = ({
  bus,
  onSubscribeCount,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onSubscribeCount: (count: number) => void;
}): React.JSX.Element => {
  // Fresh arrow function each render — if the hook re-subscribed on identity churn it would
  // cycle the bus subscription on every parent re-render. `flushMs: 20` keeps the coalescer's
  // window short so the drains below stay fast.
  const events = useEventBusBuffer<ChainCompletedEvent>(bus, {
    filter: (e: AppEvent): e is ChainCompletedEvent => e.type === 'chain-completed',
    flushMs: 20,
  });
  onSubscribeCount(events.length);
  return <Text>count={events.length}</Text>;
};

describe('useEventBusBuffer', () => {
  it('captures filter via ref so caller-side arrow churn does not drop buffered events', async () => {
    const bus = createInMemoryEventBus();

    let lastCount = -1;
    const r = render(<Probe bus={bus} onSubscribeCount={(c) => (lastCount = c)} />);

    bus.publish({ type: 'chain-completed', chainId: 'c1', at: NOW });
    bus.publish({ type: 'chain-completed', chainId: 'c2', at: NOW });
    // Drain past the coalescer's 20ms flush window so the batched setState lands.
    await new Promise((res) => setTimeout(res, 60));
    expect(lastCount).toBe(2);

    // Now publish a third event AND a non-matching one. If the hook had unsubscribed-resub'd
    // on the implicit re-render Ink might have caused, the buffer would have been reset.
    bus.publish({ type: 'chain-completed', chainId: 'c3', at: NOW });
    bus.publish({ type: 'log', level: 'info', message: 'noise', at: NOW });
    await new Promise((res) => setTimeout(res, 60));
    expect(lastCount).toBe(3);
    r.unmount();
  });
});
