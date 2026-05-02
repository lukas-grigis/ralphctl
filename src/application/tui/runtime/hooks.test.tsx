import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { logEventBus } from './event-bus.ts';
import { useLoggerEvents } from './hooks.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T00:00:00.000Z');

function Probe({ sessionId }: { readonly sessionId?: string }): React.JSX.Element {
  const events = useLoggerEvents({ max: 50, sessionId });
  // Encode as a single line per event so the test can pattern-match.
  return <Text>{events.map((e) => e.message).join('|')}</Text>;
}

afterEach(() => {
  cleanup();
});

describe('useLoggerEvents (per-session filter)', () => {
  it('returns only events tagged with the requested sessionId', async () => {
    const { lastFrame } = render(<Probe sessionId="A" />);
    // Wait for the subscribe useEffect to run.
    await new Promise((r) => setTimeout(r, 10));

    logEventBus.emit({ level: 'info', message: 'first-A', timestamp: NOW, context: { sessionId: 'A' } });
    logEventBus.emit({ level: 'info', message: 'first-B', timestamp: NOW, context: { sessionId: 'B' } });
    logEventBus.emit({ level: 'info', message: 'second-A', timestamp: NOW, context: { sessionId: 'A' } });
    logEventBus.emit({ level: 'info', message: 'untagged', timestamp: NOW, context: {} });

    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('first-A');
    expect(frame).toContain('second-A');
    expect(frame).not.toContain('first-B');
    expect(frame).not.toContain('untagged');
  });

  it('returns the unfiltered global stream when sessionId is undefined', async () => {
    const { lastFrame } = render(<Probe />);
    await new Promise((r) => setTimeout(r, 10));

    logEventBus.emit({ level: 'info', message: 'a', timestamp: NOW, context: { sessionId: 'X' } });
    logEventBus.emit({ level: 'info', message: 'b', timestamp: NOW, context: {} });

    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('a');
    expect(frame).toContain('b');
  });

  it('still accepts the legacy `useLoggerEvents(50)` numeric form', async () => {
    function LegacyProbe(): React.JSX.Element {
      const events = useLoggerEvents(50);
      return <Text>{events.length === 0 ? 'empty' : events.map((e) => e.message).join('|')}</Text>;
    }
    const { lastFrame } = render(<LegacyProbe />);
    await new Promise((r) => setTimeout(r, 10));

    logEventBus.emit({ level: 'info', message: 'legacy', timestamp: NOW, context: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain('legacy');
  });
});
