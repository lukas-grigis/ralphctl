import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { RecentEventsTail } from './recent-events-tail.tsx';
import type { LogEvent } from '@src/integration/logging/log-event-bus.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

const TS = '2026-05-01T12:34:56.000Z' as IsoTimestamp;

function makeEvent(message: string, level: LogEvent['level'] = 'info'): LogEvent {
  return { level, message, timestamp: TS, context: {} };
}

afterEach(() => {
  cleanup();
});

describe('RecentEventsTail', () => {
  it('shows empty state message when no events', () => {
    const { lastFrame } = render(<RecentEventsTail events={[]} />);
    expect(lastFrame()).toContain('No events yet');
  });

  it('renders event messages', () => {
    const events = [makeEvent('Task started'), makeEvent('Running check scripts')];
    const { lastFrame } = render(<RecentEventsTail events={events} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Task started');
    expect(frame).toContain('Running check scripts');
  });

  it('renders timestamp slice (HH:MM:SS)', () => {
    const events = [makeEvent('hello')];
    const { lastFrame } = render(<RecentEventsTail events={events} />);
    // Timestamp sliced to [11:19] = "12:34:56"
    expect(lastFrame()).toContain('12:34:56');
  });

  it('renders log level chip', () => {
    const events = [makeEvent('Something failed', 'error')];
    const { lastFrame } = render(<RecentEventsTail events={events} />);
    expect(lastFrame()).toContain('ERROR');
  });
});
