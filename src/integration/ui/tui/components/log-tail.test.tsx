/**
 * LogTail tests — verify that:
 *   (a) only `visibleLines` events render by default (cap enforcement)
 *   (b) `scrollOffset > 0` slides the window up to show older events
 *   (c) the "N hidden" indicator appears when the buffer exceeds the window
 *   (d) "no activity yet" renders on an empty buffer
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { LogEvent } from '@src/business/ports/log-event-bus.ts';
import { LogTail } from './log-tail.tsx';

const EMPTY_CONTEXT = {} as import('@src/business/ports/logger.ts').LogContext;

function logEvent(message: string): LogEvent {
  return { kind: 'log', level: 'info', message, context: EMPTY_CONTEXT, timestamp: new Date() };
}

function makeEvents(count: number): LogEvent[] {
  return Array.from({ length: count }, (_, i) => logEvent(`line ${String(i + 1)}`));
}

describe('LogTail', () => {
  it('renders "no activity yet" for an empty event list', () => {
    const { lastFrame } = render(<LogTail events={[]} />);
    expect(lastFrame() ?? '').toContain('no activity yet');
  });

  it('renders all events when count is within visibleLines', () => {
    const events = makeEvents(5);
    const { lastFrame } = render(<LogTail events={events} visibleLines={10} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 1');
    expect(frame).toContain('line 5');
  });

  it('only renders the last visibleLines events when buffer exceeds the cap', () => {
    // Use padded labels so "event-005" cannot match "event-015".
    const events = Array.from({ length: 25 }, (_, i): LogEvent => {
      const n = i + 1;
      const label = `event-${String(n).padStart(3, '0')}`;
      return { kind: 'log', level: 'info', message: label, context: EMPTY_CONTEXT, timestamp: new Date() };
    });
    const { lastFrame } = render(<LogTail events={events} visibleLines={15} scrollOffset={0} />);
    const frame = lastFrame() ?? '';
    // Window should be events 11-25.
    expect(frame).not.toContain('event-010');
    expect(frame).toContain('event-011');
    expect(frame).toContain('event-025');
  });

  it('shows a hidden-count indicator when buffer exceeds visibleLines', () => {
    const events = makeEvents(20);
    const { lastFrame } = render(<LogTail events={events} visibleLines={10} scrollOffset={0} />);
    const frame = lastFrame() ?? '';
    // At least "10 hidden" should appear somewhere
    expect(frame).toMatch(/10 hidden/);
  });

  it('scrollOffset > 0 slides the window up to expose older events', () => {
    // 25 padded events, window=10, offset=10 → shows events 006-015
    const events = Array.from({ length: 25 }, (_, i): LogEvent => {
      const n = i + 1;
      return {
        kind: 'log',
        level: 'info',
        message: `event-${String(n).padStart(3, '0')}`,
        context: EMPTY_CONTEXT,
        timestamp: new Date(),
      };
    });
    const { lastFrame } = render(<LogTail events={events} visibleLines={10} scrollOffset={10} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('event-006');
    expect(frame).toContain('event-015');
    expect(frame).not.toContain('event-016');
  });

  it('clamps scrollOffset to maxOffset so the window never goes out of range', () => {
    // offset=9999 on 5 events → clamps to show whatever is available
    const events = makeEvents(5);
    const { lastFrame } = render(<LogTail events={events} visibleLines={10} scrollOffset={9999} />);
    const frame = lastFrame() ?? '';
    // All 5 events are within the window even at max offset
    expect(frame).toContain('line 1');
    expect(frame).toContain('line 5');
  });

  it('shows lines-above indicator when scrollOffset is positive', () => {
    const events = makeEvents(30);
    const { lastFrame } = render(<LogTail events={events} visibleLines={10} scrollOffset={5} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('above');
  });
});
